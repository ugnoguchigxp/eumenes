import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { createLarm, type LarmPort, type LarmExchange } from "../../larm";
import type { SpeechPreparation } from "../../delivery/contracts";
import type {
	SettingsService,
	Settings,
	Purpose,
	Connection,
} from "../../settings";
import type {
	InferencePort,
	Messages,
	Receipt,
	SpeechOverride,
} from "../contracts";
import { get, type RequestRow } from "../repository";
import {
	executeRequest as runRequest,
	type CollectionAdoption,
	type Env,
	type InferenceOptions,
	type Running,
} from "./execute";
import { probeWav } from "./wav";
import { safeError } from "./errors";
type UsageRow = {
	id: string;
	requestId: string;
	subject: string;
	purpose: Purpose;
	source: "larm" | "cloud";
	model: string | null;
	status: string;
	reason: string | null;
	started: number;
	ended: number | null;
	accepted: number;
	inputTokens: number | null;
	outputTokens: number | null;
	providerDetails: string;
};
export function createInference(
	store: SqliteStore,
	settings: SettingsService,
	options: InferenceOptions = {},
) {
	const ports = new Map<string, LarmPort>();
	const collectionAdoptions = new Map<string, CollectionAdoption>();
	const unsubscribeCollection = options.attitudeDataset
		? store.onCommit(() => {
				for (const [id, entry] of collectionAdoptions) {
					const state = store.read((db) => get(db, id))?.status;
					if (state === "accepted") {
						collectionAdoptions.delete(id);
						options.attitudeDataset!.adopt(
							entry.identity,
							entry.delivery,
							entry.voice,
						);
					} else if (state && state !== "pending")
						collectionAdoptions.delete(id);
				}
			})
		: () => {};
	const listeners = new Set<() => void>();
	const statusSubscriptions = new Map<string, () => void>();
	const active = new Map<string, Running>();
	const cooldown = new Map<string, number>();
	const closingPorts = new Set<Promise<void>>();
	function prune() {
		const keep = new Set([
			JSON.stringify(settings.get().larm),
			...[...active.values()].map((a) => JSON.stringify(a.row.snapshot.larm)),
		]);
		for (const [name, p] of ports)
			if (!keep.has(name)) {
				ports.delete(name);
				statusSubscriptions.get(name)?.();
				statusSubscriptions.delete(name);
				const done = p.close();
				closingPorts.add(done);
				void done.finally(() => closingPorts.delete(done)).catch(() => {});
			}
	}
	let closed = false;
	function port(s: Settings) {
		const key = JSON.stringify(s.larm);
		let p = ports.get(key);
		if (!p) {
			p =
				options.larmFactory?.(s) ??
				createLarm({
					baseUrl: s.larm.baseUrl ?? undefined,
					token: options.token,
					profile: s.larm.profile,
					audience: s.larm.audience,
					voice: s.larm.voice || undefined,
					speed: s.larm.speed,
					style: s.larm.style,
					pitchScale: s.larm.pitchScale,
					intonationScale: s.larm.intonationScale,
				});
			ports.set(key, p);
			const unsubscribeStatus = p.onChange?.(() => {
				if (key !== JSON.stringify(settings.get().larm)) return;
				for (const listener of listeners) listener();
			});
			if (unsubscribeStatus) statusSubscriptions.set(key, unsubscribeStatus);
		}
		return p;
	}
	function resolve(row: RequestRow) {
		const id = row.snapshot.routes[row.purpose].fallbackId;
		const resource = row.snapshot.resources.find((r) => r.id === id);
		const connection = row.snapshot.connections.find(
			(c) => c.id === resource?.connectionId,
		);
		return resource && connection ? { resource, connection } : null;
	}
	function allowed(db: Database, row: RequestRow, connection?: Connection) {
		return (
			get(db, row.id)?.status === "pending" &&
			row.deadline > Date.now() &&
			settings.valid(db, row.snapshot, row.purpose, connection) &&
			row.parents.every((id) =>
				row.purpose === "tts" ? usable(db, id) : valid(db, id),
			)
		);
	}
	const unsubscribe = settings.onChange(() => {
		prune();
		for (const a of active.values())
			if (!store.read((db) => allowed(db, a.row, a.connection)))
				a.controller.abort();
	});
	function capture(
		db: Database,
		subject: string,
		purpose: Purpose,
		deadline: number,
		snapshot = settings.inTransaction(db),
	) {
		const old = db
			.query("SELECT id FROM inference_requests WHERE subject=? AND purpose=?")
			.get(subject, purpose) as { id: string } | null;
		if (old) return old.id;
		const id = crypto.randomUUID();
		db.query(
			"INSERT INTO inference_requests(id,subject,purpose,snapshot,deadline) VALUES(?,?,?,?,?)",
		).run(id, subject, purpose, JSON.stringify(snapshot), deadline);
		return id;
	}
	const env: Env = {
		store,
		settings,
		options,
		active,
		cooldown,
		collectionAdoptions,
		port,
		resolve,
		allowed,
		prune,
		isClosed: () => closed,
	};
	const executeRequest = (
		requestId: string,
		input: Messages | string | Uint8Array,
		caller: AbortSignal,
		onDelta?: (text: string) => void,
		preparation?: SpeechPreparation,
	) => runRequest(env, requestId, input, caller, onDelta, preparation);
	function accept(db: Database, receipt: Receipt) {
		const row = get(db, receipt.requestId);
		const a = db
			.query(
				"SELECT source,connection_id,status FROM inference_attempts WHERE id=? AND request_id=?",
			)
			.get(receipt.attemptId, receipt.requestId) as {
			source: string;
			connection_id: string | null;
			status: string;
		} | null;
		if (!row || !a || a.status !== "succeeded") return false;
		const connection =
			a.source === "cloud"
				? row.snapshot.connections.find((c) => c.id === a.connection_id)
				: undefined;
		if (!allowed(db, row, connection)) return false;
		db.query("UPDATE inference_attempts SET accepted=1 WHERE id=?").run(
			receipt.attemptId,
		);
		db.query("UPDATE inference_requests SET status='accepted' WHERE id=?").run(
			row.id,
		);
		return true;
	}
	async function standaloneReceipt(
		purpose: Purpose,
		input: Messages | string | Uint8Array,
		signal: AbortSignal,
		onDelta?: (text: string) => void,
		override?: SpeechOverride,
		preparation?: SpeechPreparation,
	) {
		const id = await store.write((db) => {
			const current = settings.inTransaction(db);
			return capture(
				db,
				crypto.randomUUID(),
				purpose,
				Date.now() + (purpose === "llm" ? 180_000 : 45_000),
				override
					? { ...current, larm: { ...current.larm, ...override } }
					: current,
			);
		});
		const receipt = await executeRequest(
			id,
			input,
			signal,
			onDelta,
			preparation,
		);
		if (!(await store.write((db) => accept(db, receipt))))
			throw new Error("permission_revoked");
		return receipt;
	}
	async function standalone(
		purpose: Purpose,
		input: Messages | string | Uint8Array,
		signal: AbortSignal,
		onDelta?: (text: string) => void,
		override?: SpeechOverride,
	) {
		return (await standaloneReceipt(purpose, input, signal, onDelta, override))
			.value;
	}
	function valid(db: Database, id: string) {
		const row = get(db, id);
		if (
			!row ||
			row.status !== "accepted" ||
			!row.parents.every((parent) =>
				row.purpose === "tts" ? usable(db, parent) : valid(db, parent),
			)
		)
			return false;
		const selected = resolve(row);
		const cloud = db
			.query(
				"SELECT id FROM inference_attempts WHERE request_id=? AND source='cloud' AND accepted=1",
			)
			.get(id);
		return settings.valid(
			db,
			row.snapshot,
			row.purpose,
			cloud ? selected?.connection : undefined,
		);
	}

	// TTS is provisional while its parent answer is still arriving. It cannot
	// outlive cancellation/revocation or authorize a non-TTS dependent request.
	function usable(db: Database, id: string): boolean {
		const row = get(db, id);
		if (!row) return false;
		if (row.status === "accepted") return valid(db, id);
		if (
			row.status !== "pending" ||
			row.purpose !== "llm" ||
			row.deadline <= Date.now() ||
			!row.parents.every((parent) => valid(db, parent))
		)
			return false;
		const running = active.get(id);
		const completed = db
			.query(
				"SELECT source,connection_id FROM inference_attempts WHERE request_id=? AND status='succeeded' ORDER BY started DESC LIMIT 1",
			)
			.get(id) as { source: string; connection_id: string | null } | null;
		if ((!running || running.controller.signal.aborted) && !completed)
			return false;
		const connection =
			running?.connection ??
			(completed?.source === "cloud"
				? row.snapshot.connections.find((c) => c.id === completed.connection_id)
				: undefined);
		return settings.valid(db, row.snapshot, row.purpose, connection);
	}

	const service = {
		snapshotFor(db: Database, subject: string) {
			const row = db
				.query(
					"SELECT snapshot FROM inference_requests WHERE subject=? LIMIT 1",
				)
				.get(subject) as { snapshot: string } | null;
			return row ? (JSON.parse(row.snapshot) as Settings) : null;
		},
		bindInTransaction(
			db: Database,
			voiceSubject: string,
			runSubject: string,
			deadline?: number,
		) {
			const transcription = db
				.query(
					"SELECT id FROM inference_requests WHERE subject=? AND purpose='asr'",
				)
				.get(voiceSubject) as { id: string } | null;
			if (transcription && !valid(db, transcription.id))
				throw new Error("permission_revoked");
			const row = db
				.query(
					"SELECT id,status FROM inference_requests WHERE subject=? AND purpose='llm'",
				)
				.get(voiceSubject) as { id: string; status: string } | null;
			if (!row || row.status !== "pending")
				throw new Error("invalid_voice_inference");
			if (transcription) {
				db.query("UPDATE inference_requests SET parents=? WHERE id=?").run(
					JSON.stringify([transcription.id]),
					row.id,
				);
				db.query(
					"UPDATE inference_requests SET parents=? WHERE subject=? AND purpose='tts'",
				).run(JSON.stringify([transcription.id, row.id]), voiceSubject);
			}
			db.query(
				"UPDATE inference_requests SET subject=?,deadline=MIN(deadline,?) WHERE id=?",
			).run(runSubject, deadline ?? Number.MAX_SAFE_INTEGER, row.id);
		},
		async cancelSubject(subject: string) {
			await store.write((db) =>
				db
					.query(
						"UPDATE inference_requests SET status='cancelled' WHERE (subject=? OR substr(subject,1,?)=?) AND status='pending'",
					)
					.run(subject, `${subject}:speech:`.length, `${subject}:speech:`),
			);
			for (const a of active.values())
				if (
					a.row.subject === subject ||
					a.row.subject.startsWith(`${subject}:speech:`)
				)
					a.controller.abort();
		},
		snapshotInTransaction: settings.inTransaction,
		captureInTransaction: capture,
		executeRequest: (
			id: string,
			input: Messages | string | Uint8Array,
			signal: AbortSignal,
			preparation?: SpeechPreparation,
		) => executeRequest(id, input, signal, undefined, preparation),
		executeStream: (
			requestId: string,
			messages: Messages,
			signal: AbortSignal,
			onDelta: (text: string) => void,
			preparation?: SpeechPreparation,
		) => executeRequest(requestId, messages, signal, onDelta, preparation),
		liveRequest: (id: string) => store.read((db) => usable(db, id)),
		captureSpeechChunkInTransaction(
			db: Database,
			voiceSubject: string,
			index: number,
		) {
			const parent = db
				.query(
					"SELECT id FROM inference_requests WHERE subject=? AND purpose='tts'",
				)
				.get(voiceSubject) as { id: string } | null;
			const original = parent ? get(db, parent.id) : null;
			if (!original || !original.parents.every((id) => usable(db, id)))
				throw new Error("permission_revoked");
			const id = capture(
				db,
				`${voiceSubject}:speech:${index}`,
				"tts",
				original.deadline,
				original.snapshot,
			);
			db.query("UPDATE inference_requests SET parents=? WHERE id=?").run(
				JSON.stringify(original.parents),
				id,
			);
			return id;
		},
		acceptInTransaction: accept,
		requestFor(db: Database, subject: string, purpose: Purpose) {
			return (
				(
					db
						.query(
							"SELECT id FROM inference_requests WHERE subject=? AND purpose=?",
						)
						.get(subject, purpose) as { id: string } | null
				)?.id ?? null
			);
		},
		validInTransaction: valid,
		validRequest(id: string) {
			return store.read((db) => valid(db, id));
		},
		skipInTransaction(db: Database, subject: string, purpose: Purpose) {
			db.query(
				"UPDATE inference_requests SET status='skipped' WHERE subject=? AND purpose=? AND status='pending'",
			).run(subject, purpose);
		},
		connect: () => port(settings.get()).connect(),
		prepareVoice: (signal: AbortSignal) =>
			port(settings.get()).prepareVoice?.(signal) ?? Promise.resolve(),
		status: () => port(settings.get()).status(),
		onChange(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		inspect: () =>
			port(settings.get()).inspect?.() ?? {
				profile: settings.get().larm.profile,
				providers: [],
			},
		voices: async (signal: AbortSignal) => {
			const snapshot = settings.get();
			const result = await port(snapshot).voices?.(signal);
			if (!result) throw new Error("larm_voice_discovery_unsupported");
			if (JSON.stringify(snapshot.larm) !== JSON.stringify(settings.get().larm))
				throw new Error("stale_voice_settings");
			return result;
		},
		answer: (messages: Messages, signal: AbortSignal) =>
			standalone("llm", messages, signal) as Promise<string>,
		answerStream: (
			messages: Messages,
			signal: AbortSignal,
			onDelta: (text: string) => void,
		) => standalone("llm", messages, signal, onDelta) as Promise<string>,
		transcribe: (wav: Uint8Array, signal: AbortSignal) =>
			standalone("asr", wav, signal) as Promise<string>,
		speak: (text: string, signal: AbortSignal, override?: SpeechOverride) =>
			standalone(
				"tts",
				text,
				signal,
				undefined,
				override,
			) as Promise<Uint8Array>,
		speakWithDelivery: async (
			text: string,
			signal: AbortSignal,
			preparation?: SpeechPreparation,
		) => {
			const receipt = await standaloneReceipt(
				"tts",
				text,
				signal,
				undefined,
				undefined,
				preparation,
			);
			return { wav: receipt.value as Uint8Array, delivery: receipt.delivery };
		},
		usage: () =>
			store.read((db) =>
				db
					.query(
						"SELECT a.id,a.request_id AS requestId,r.subject,r.purpose,a.source,a.model,a.status,a.reason,a.started,a.ended,a.accepted,a.input_tokens AS inputTokens,a.output_tokens AS outputTokens,a.provider_details AS providerDetails FROM inference_attempts a JOIN inference_requests r ON r.id=a.request_id WHERE r.subject NOT LIKE 'probe:%' ORDER BY a.started DESC LIMIT 100",
					)
					.all()
					.map((row) => {
						const value = row as UsageRow;
						return {
							...value,
							providerDetails: JSON.parse(
								value.providerDetails,
							) as LarmExchange[],
						};
					}),
			),
		getProbe: (id: string) =>
			store.read((db) =>
				db.query("SELECT * FROM inference_probes WHERE id=?").get(id),
			),
		probes: () =>
			store.read((db) =>
				db
					.query(
						"SELECT * FROM inference_probes ORDER BY created DESC LIMIT 20",
					)
					.all(),
			),
		async testResource(
			resourceId: string,
			input: Messages | string | Uint8Array,
			signal: AbortSignal,
		) {
			const snapshot = settings.get();
			const resource = snapshot.resources.find((r) => r.id === resourceId);
			if (!resource) throw new Error("invalid_probe_target");
			const fixed = structuredClone(snapshot);
			fixed.routes[resource.purpose].mode = "cloud-only";
			fixed.routes[resource.purpose].fallbackId = resourceId;
			const id = await store.write((db) =>
				capture(
					db,
					`probe:${crypto.randomUUID()}`,
					resource.purpose,
					Date.now() + 120_000,
					fixed,
				),
			);
			const receipt = await executeRequest(id, input, signal);
			signal.throwIfAborted();
			if (!(await store.write((db) => accept(db, receipt))))
				throw new Error("permission_revoked");
			return receipt.value;
		},
		async startProbe(target: string) {
			const current = settings.get();
			const id = crypto.randomUUID();
			const controller = new AbortController();

			await store.write((db) => {
				if (
					db
						.query("SELECT id FROM inference_probes WHERE status='running'")
						.get()
				)
					throw new Error("invalid_probe_busy");
				return db
					.query("INSERT INTO inference_probes VALUES(?,?,'running',NULL,?,?)")
					.run(id, target, current.revision, Date.now());
			});
			probeControllers.set(id, controller);
			const task = (async () => {
				try {
					if (target === "larm") {
						await port(current).probe?.(
							AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
						);
					} else {
						const resource = current.resources.find((r) => r.id === target);
						if (!resource) throw new Error("invalid_probe_target");

						const snap = structuredClone(current);
						snap.routes[resource.purpose].mode = "cloud-only";
						snap.routes[resource.purpose].fallbackId = resource.id;
						const requestId = await store.write((db) =>
							capture(
								db,
								`probe:${id}`,
								resource.purpose,
								Date.now() + 15_000,
								snap,
							),
						);
						const receipt = await executeRequest(
							requestId,
							resource.purpose === "llm"
								? [{ role: "user", content: "Reply OK." }]
								: resource.purpose === "tts"
									? "接続のテストです。"
									: probeWav(),
							controller.signal,
						);
						if (!(await store.write((db) => accept(db, receipt))))
							throw new Error("permission_revoked");
					}
					controller.signal.throwIfAborted();
					await store.write((db) =>
						db
							.query("UPDATE inference_probes SET status=? WHERE id=?")
							.run(
								settings.get().revision === current.revision
									? "succeeded"
									: "stale",
								id,
							),
					);
				} catch (error) {
					await store.write((db) =>
						db
							.query("UPDATE inference_probes SET status=?,error=? WHERE id=?")
							.run(
								controller.signal.aborted ? "cancelled" : "failed",
								safeError(error, controller.signal),
								id,
							),
					);
				} finally {
					probeControllers.delete(id);
				}
			})();
			probeTasks.add(task);
			void task.finally(() => probeTasks.delete(task)).catch(() => {});
			return { id };
		},
		cancelProbe(id: string) {
			probeControllers.get(id)?.abort();
		},
		async recover() {
			await store.write((db) => {
				db.query(
					"UPDATE inference_requests SET status='interrupted' WHERE status='pending' AND EXISTS(SELECT 1 FROM inference_attempts WHERE request_id=inference_requests.id)",
				).run();
				db.query(
					"UPDATE inference_attempts SET status='interrupted',ended=? WHERE status='running'",
				).run(Date.now());
				db.query(
					"UPDATE inference_probes SET status='interrupted' WHERE status='running'",
				).run();
			});
		},
		async close() {
			unsubscribeCollection();
			collectionAdoptions.clear();
			closed = true;
			unsubscribe();
			for (const stop of statusSubscriptions.values()) stop();
			statusSubscriptions.clear();
			listeners.clear();
			const pending = [...active.values()];
			for (const a of pending) a.controller.abort();
			for (const c of probeControllers.values()) c.abort();
			await Promise.all(pending.map((a) => a.done));
			await Promise.allSettled(probeTasks);
			await Promise.all([...ports.values()].map((p) => p.close()));
			await Promise.allSettled(closingPorts);
		},
	} satisfies InferencePort & Record<string, unknown>;
	const probeControllers = new Map<string, AbortController>();
	const probeTasks = new Set<Promise<void>>();
	return service;
}
export type InferenceService = ReturnType<typeof createInference>;
