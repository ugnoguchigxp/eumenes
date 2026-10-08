import { readChatResponse } from "../../../infrastructure/chat-stream";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { createLarm, type LarmPort, type LarmExchange } from "../../larm";
import type {
	SettingsService,
	Settings,
	Purpose,
	Connection,
	Resource,
} from "../../settings";
import type { InferencePort, Messages, Receipt } from "../contracts";
import { get, type RequestRow } from "../repository";
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
const fallbackErrors =
	/^(larm_unconfigured|larm_(control|inference)_(429|502|503|504)|larm_connection_(failed|expired)|larm_expired|larm_credential_expired|larm_renew_busy|larm_connect_timeout|network_unavailable|local_timeout)$/;
function probeWav() {
	const bytes = new Uint8Array(32044);
	const view = new DataView(bytes.buffer);
	const tag = (offset: number, text: string) =>
		bytes.set(new TextEncoder().encode(text), offset);
	tag(0, "RIFF");
	view.setUint32(4, bytes.length - 8, true);
	tag(8, "WAVE");
	tag(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, 16000, true);
	view.setUint32(28, 32000, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	tag(36, "data");
	view.setUint32(40, 32000, true);
	return bytes;
}
function safeError(error: unknown, signal: AbortSignal): string {
	if (signal.aborted)
		return signal.reason instanceof DOMException &&
			signal.reason.name === "TimeoutError"
			? "deadline_exceeded"
			: "cancelled";
	if (error instanceof DOMException && error.name === "TimeoutError")
		return "local_timeout";
	if (error instanceof TypeError) return "network_unavailable";
	const message = error instanceof Error ? error.message : "inference_failed";
	return /^[a-z][a-z0-9_]{0,100}$/.test(message) ? message : "inference_failed";
}
async function bounded(response: Response, limit: number) {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("invalid_response");
	const chunks: Uint8Array[] = [];
	let length = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		length += value.length;
		if (length > limit) {
			await reader.cancel();
			throw new Error("response_too_large");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const c of chunks) {
		bytes.set(c, offset);
		offset += c.length;
	}
	return bytes;
}
export function createInference(
	store: SqliteStore,
	settings: SettingsService,
	options: {
		token?: string;
		fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
		larmFactory?: (s: Settings) => LarmPort;
		localMs?: number;
		cloudMs?: number;
	} = {},
) {
	const ports = new Map<string, LarmPort>();
	const listeners = new Set<() => void>();
	const statusSubscriptions = new Map<string, () => void>();
	const active = new Map<
		string,
		{
			controller: AbortController;
			row: RequestRow;
			connection?: Connection;
			done: Promise<void>;
			finish: () => void;
		}
	>();
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
	async function cloud(
		row: RequestRow,
		input: Messages | string | Uint8Array,
		connection: Connection,
		resource: Resource,
		signal: AbortSignal,
		attemptId: string,
		onDelta?: (text: string) => void,
	) {
		const credential = settings.credential(connection);
		if (!credential) throw new Error("cloud_credential_unavailable");
		const base = new URL(
			connection.baseUrl.endsWith("/")
				? connection.baseUrl
				: `${connection.baseUrl}/`,
		);
		const init: RequestInit = {
			method: "POST",
			signal,
			redirect: "error",
			headers: { Authorization: `Bearer ${credential}` },
		};
		if (row.purpose === "asr") {
			const form = new FormData();
			form.append(
				"file",
				new Blob([new Uint8Array(input as Uint8Array)], { type: "audio/wav" }),
				"speech.wav",
			);
			form.append("model", resource.model);
			form.append("response_format", "json");
			init.body = form;
		} else {
			let body: unknown;
			if (row.purpose === "tts")
				body = {
					model: resource.model,
					input,
					voice: resource.voice,
					response_format: "wav",
				};
			else {
				const messages = [...(input as Messages)];
				const reserve = Math.min(
					4096,
					Math.floor((resource.contextWindow ?? 0) / 4),
				);
				const budget = (resource.contextWindow ?? 0) - reserve - 512;
				const estimate = () =>
					new TextEncoder().encode(JSON.stringify(messages)).length +
					messages.length * 16;
				while (messages.length > 2 && estimate() > budget)
					messages.splice(1, Math.min(2, messages.length - 2));
				if (estimate() > budget) throw new Error("context_window_exceeded");
				body = {
					model: resource.model,
					messages,
					stream: !!onDelta,
					max_tokens: reserve,
				};
			}
			init.headers = { ...init.headers, "Content-Type": "application/json" };
			init.body = JSON.stringify(body);
		}
		const path =
			row.purpose === "llm"
				? "chat/completions"
				: row.purpose === "asr"
					? "audio/transcriptions"
					: "audio/speech";
		const response = await (options.fetch ?? fetch)(new URL(path, base), init);
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`cloud_http_${response.status}`);
		}
		if (row.purpose === "llm") {
			const result = await readChatResponse(response, signal, onDelta);
			const count = (v: unknown) =>
				typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
			signal.throwIfAborted();
			await store.write((db) =>
				db
					.query(
						"UPDATE inference_attempts SET input_tokens=?,output_tokens=? WHERE id=?",
					)
					.run(
						count(result.usage?.prompt_tokens),
						count(result.usage?.completion_tokens),
						attemptId,
					),
			);
			return result.text;
		}

		const bytes = await bounded(
			response,
			row.purpose === "tts" ? 16_000_000 : 1_000_000,
		);
		if (row.purpose === "tts") {
			if (
				bytes.length < 44 ||
				new TextDecoder().decode(bytes.subarray(0, 4)) !== "RIFF" ||
				new TextDecoder().decode(bytes.subarray(8, 12)) !== "WAVE"
			)
				throw new Error("invalid_tts_audio");
			return bytes;
		}
		let json: Record<string, unknown>;
		try {
			json = JSON.parse(new TextDecoder().decode(bytes)) as Record<
				string,
				unknown
			>;
		} catch {
			throw new Error("invalid_response_json");
		}
		const value =
			row.purpose === "asr"
				? json.text
				: (
						json.choices as
							| Array<{ message?: { content?: unknown } }>
							| undefined
					)?.[0]?.message?.content;
		if (
			typeof value !== "string" ||
			(!value.trim() &&
				!(row.purpose === "asr" && row.subject.startsWith("probe:")))
		)
			throw new Error("invalid_response_text");
		const usage = json.usage as
			| { prompt_tokens?: unknown; completion_tokens?: unknown }
			| undefined;
		signal.throwIfAborted();
		const count = (v: unknown) =>
			typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
		await store.write((db) =>
			db
				.query(
					"UPDATE inference_attempts SET input_tokens=?,output_tokens=? WHERE id=?",
				)
				.run(
					count(usage?.prompt_tokens),
					count(usage?.completion_tokens),
					attemptId,
				),
		);
		return value;
	}
	async function executeRequest(
		requestId: string,
		input: Messages | string | Uint8Array,
		caller: AbortSignal,
		onDelta?: (text: string) => void,
	): Promise<Receipt> {
		caller.throwIfAborted();
		if (closed) throw new Error("inference_closed");
		const found = store.read((db) => get(db, requestId));
		if (!found) throw new Error("inference_request_missing");
		const row: RequestRow = found;
		if (
			row.purpose === "asr" &&
			(!(input instanceof Uint8Array) ||
				input.length < 44 ||
				input.length > 4_000_000)
		)
			throw new Error("invalid_audio");
		const route = row.snapshot.routes[row.purpose];
		const selected = resolve(row);
		const controller = new AbortController();
		const deadline = Math.min(
			row.deadline,
			Date.now() + (row.purpose === "llm" ? 180_000 : 45_000),
		);
		row.deadline = deadline;
		await store.write((db) =>
			db
				.query(
					"UPDATE inference_requests SET deadline=MIN(deadline,?) WHERE id=?",
				)
				.run(deadline, row.id),
		);
		const signal = AbortSignal.any([
			caller,
			controller.signal,
			AbortSignal.timeout(Math.max(1, deadline - Date.now())),
		]);
		if (active.has(row.id)) throw new Error("inference_request_running");
		let finish: () => void = () => {};
		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const running: {
			controller: AbortController;
			row: RequestRow;
			connection?: Connection;
			done: Promise<void>;
			finish: () => void;
		} = { controller, row, done, finish };
		active.set(row.id, running);
		let reason: string | null = null;
		let published = false;
		const key = `${row.purpose}:${JSON.stringify({ larm: row.snapshot.larm, route, resource: selected?.resource, connection: selected?.connection })}`;
		async function attempt(source: "larm" | "cloud") {
			if (signal.aborted) throw new Error("cancelled");
			const connection = source === "cloud" ? selected?.connection : undefined;
			running.connection = connection;
			if (!store.read((db) => allowed(db, row, connection)))
				throw new Error("permission_revoked");
			if (
				source === "cloud" &&
				(!selected || !selected.connection.enabled || !route.cloudAllowed)
			)
				throw new Error("cloud_fallback_unconfigured");
			const attemptId = crypto.randomUUID();
			await store.write((db) =>
				db
					.query(
						"INSERT INTO inference_attempts(id,request_id,source,connection_id,resource_id,model,status,reason,started) VALUES(?,?,?,?,?,?,'running',?,?)",
					)
					.run(
						attemptId,
						row.id,
						source,
						connection?.id ?? null,
						source === "cloud" ? (selected?.resource.id ?? null) : null,
						source === "cloud"
							? (selected?.resource.model ?? null)
							: row.snapshot.larm.profile,
						reason,
						Date.now(),
					),
			);
			const exchanges: LarmExchange[] = [];
			const callOptions = {
				onExchange: async (exchange: LarmExchange) => {
					// A call can use the old lease and one replacement. Keep both for correlation.
					if (exchanges.length >= 2) return;
					exchanges.push(exchange);
					await store.write((db) =>
						db
							.query(
								"UPDATE inference_attempts SET provider_details=?,model=? WHERE id=?",
							)
							.run(JSON.stringify(exchanges), exchange.model, attemptId),
					);
				},
			};
			const abort = new AbortController();
			const configuredDuration =
				source === "cloud"
					? (options.cloudMs ?? (row.purpose === "llm" ? 60_000 : 30_000))
					: (options.localMs ?? (row.purpose === "llm" ? 120_000 : 15_000));
			const remaining = Math.max(0, deadline - Date.now());
			const reserve =
				source === "larm" &&
				route.mode === "larm-preferred" &&
				selected?.connection.enabled &&
				route.cloudAllowed
					? Math.min(
							options.cloudMs ?? (row.purpose === "llm" ? 60_000 : 30_000),
							remaining,
						)
					: 0;
			const duration = Math.min(
				configuredDuration,
				Math.max(1, remaining - reserve),
			);
			const timer = setTimeout(
				() => abort.abort(new DOMException("deadline", "TimeoutError")),
				Math.min(duration, Math.max(1, deadline - Date.now())),
			);
			const attemptSignal = AbortSignal.any([signal, abort.signal]);
			const delta = onDelta
				? (text: string) => {
						attemptSignal.throwIfAborted();
						if (!store.read((db) => allowed(db, row, connection)))
							throw new Error("permission_revoked");
						if (text) {
							published = true;
							onDelta(text);
						}
					}
				: undefined;
			try {
				const work =
					source === "cloud"
						? cloud(
								row,
								input,
								selected!.connection,
								selected!.resource,
								attemptSignal,
								attemptId,
								delta,
							)
						: row.purpose === "llm"
							? delta && port(row.snapshot).answerStream
								? port(row.snapshot).answerStream!(
										input as Messages,
										attemptSignal,
										delta,
										callOptions,
									)
								: port(row.snapshot)
										.answer(input as Messages, attemptSignal, callOptions)
										.then((value) => {
											delta?.(value);
											return value;
										})
							: row.purpose === "asr"
								? port(row.snapshot).transcribe(
										input as Uint8Array,
										attemptSignal,
										callOptions,
									)
								: port(row.snapshot).speak(
										input as string,
										attemptSignal,
										callOptions,
									);
				// Fence even adapters that ignore cancellation: their late result is never adopted.
				const value = await new Promise<string | Uint8Array>(
					(resolve, reject) => {
						const stop = () => reject(attemptSignal.reason);
						attemptSignal.addEventListener("abort", stop, { once: true });
						if (attemptSignal.aborted) stop();
						void work
							.then(resolve, reject)
							.finally(() => attemptSignal.removeEventListener("abort", stop));
					},
				);
				if (
					attemptSignal.aborted ||
					!store.read((db) => allowed(db, row, connection))
				)
					throw new Error("permission_revoked");
				const localModel =
					source === "larm"
						? port(row.snapshot)
								.inspect?.()
								.providers.find((p) => p.name === row.purpose)?.model
						: undefined;
				await store.write((db) =>
					db
						.query(
							"UPDATE inference_attempts SET status='succeeded',ended=?,model=COALESCE(?,model) WHERE id=?",
						)
						.run(Date.now(), localModel ?? null, attemptId),
				);
				return { requestId: row.id, attemptId, value };
			} catch (error) {
				const code =
					abort.signal.aborted && !signal.aborted
						? "local_timeout"
						: safeError(error, signal);
				await store.write((db) =>
					db
						.query(
							"UPDATE inference_attempts SET status='failed',reason=?,ended=? WHERE id=?",
						)
						.run(code, Date.now(), attemptId),
				);
				throw new Error(code);
			} finally {
				clearTimeout(timer);
				abort.abort();
			}
		}
		try {
			if (route.mode !== "cloud-only") {
				if (
					(cooldown.get(key) ?? 0) > Date.now() &&
					route.mode === "larm-preferred" &&
					selected &&
					selected.connection.enabled &&
					route.cloudAllowed
				)
					reason = "local_cooldown";
				else
					try {
						const result = await attempt("larm");
						cooldown.delete(key);
						return result;
					} catch (error) {
						reason = safeError(error, signal);
						if (
							signal.aborted ||
							published ||
							route.mode === "larm-only" ||
							!fallbackErrors.test(reason)
						)
							throw error;
						cooldown.set(key, Date.now() + 30_000);
					}
			}
			return await attempt("cloud");
		} catch (error) {
			await store.write((db) =>
				db
					.query(
						"UPDATE inference_requests SET status='failed' WHERE id=? AND status='pending'",
					)
					.run(row.id),
			);
			throw error;
		} finally {
			active.delete(row.id);
			running.finish();
			prune();
		}
	}
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
	async function standalone(
		purpose: Purpose,
		input: Messages | string | Uint8Array,
		signal: AbortSignal,
		onDelta?: (text: string) => void,
	) {
		const id = await store.write((db) =>
			capture(
				db,
				crypto.randomUUID(),
				purpose,
				Date.now() + (purpose === "llm" ? 180_000 : 45_000),
			),
		);
		const receipt = await executeRequest(id, input, signal, onDelta);
		if (!(await store.write((db) => accept(db, receipt))))
			throw new Error("permission_revoked");
		return receipt.value;
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
		executeRequest,
		executeStream: (
			requestId: string,
			messages: Messages,
			signal: AbortSignal,
			onDelta: (text: string) => void,
		) => executeRequest(requestId, messages, signal, onDelta),
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
		answer: (messages: Messages, signal: AbortSignal) =>
			standalone("llm", messages, signal) as Promise<string>,
		answerStream: (
			messages: Messages,
			signal: AbortSignal,
			onDelta: (text: string) => void,
		) => standalone("llm", messages, signal, onDelta) as Promise<string>,
		transcribe: (wav: Uint8Array, signal: AbortSignal) =>
			standalone("asr", wav, signal) as Promise<string>,
		speak: (text: string, signal: AbortSignal) =>
			standalone("tts", text, signal) as Promise<Uint8Array>,
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
