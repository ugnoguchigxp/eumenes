import { createHash } from "node:crypto";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { getLogger } from "../../../infrastructure/logger";
import {
	createLarmPlayground,
	playgroundError,
	silentWav,
	type LarmPlayground,
	type LarmTestTarget,
	type TestOutput,
	type TestProgress,
} from "../../larm";
import type { SettingsService } from "../../settings";
import type { InferenceService } from "../../inference";
import {
	startSchema,
	type ServiceCatalog,
	type ServiceTarget,
	type ServiceRun,
	type StartTest,
	type HealthRow,
} from "../contracts";
import { readRun, readRuns, updateRun, type RunRecord } from "../repository";

export function createServiceTests(
	store: SqliteStore,
	settings: SettingsService,
	inference: Pick<InferenceService, "testResource">,
	options: {
		token?: string;
		gateway?: (s: ReturnType<SettingsService["get"]>) => LarmPlayground;
		fetch?: typeof fetch;
	} = {},
) {
	const log = getLogger("service-tests");
	let discovered:
		| { catalog: ServiceCatalog; targets: Map<string, LarmTestTarget> }
		| undefined;
	let refreshing: Promise<ServiceCatalog> | undefined;
	let closed = false;
	const active = new Map<string, AbortController>();
	const tasks = new Set<Promise<void>>();
	const previews = new Map<string, { output: TestOutput; expires: number }>();
	const uploads = new Map<string, { bytes: Uint8Array; expires: number }>();
	function gateway(s = settings.get()) {
		return (
			options.gateway?.(s) ??
			createLarmPlayground({
				baseUrl: s.larm.baseUrl ?? undefined,
				token: options.token,
				profile: s.larm.profile,
				audience: s.larm.audience,
				voice: s.larm.voice,
				fetch: options.fetch,
			})
		);
	}
	function prune() {
		const now = Date.now();
		for (const [id, p] of previews) if (p.expires < now) previews.delete(id);
		for (const [id, u] of uploads) if (u.expires < now) uploads.delete(id);
		while (previews.size > 16) previews.delete(previews.keys().next().value!);
		let total = [...previews.values()].reduce(
			(n, p) => n + (p.output.bytes?.length ?? 0),
			0,
		);
		for (const [id, p] of previews) {
			if (total <= 256_000_000) break;
			previews.delete(id);
			total -= p.output.bytes?.length ?? 0;
		}
	}
	function publicRun(r: RunRecord): ServiceRun {
		prune();
		const { target: _target, artifact: _artifact, ...safe } = r;
		const p = previews.get(r.id)?.output;
		return {
			...safe,
			text: p?.text,
			mime: p?.mime,
			previewAvailable: !!p,
			retryArtifact:
				!!r.artifact &&
				r.revision === settings.get().revision &&
				["succeeded", "result-unavailable"].includes(r.status),
		};
	}
	function cloudTargets(): ServiceTarget[] {
		const s = settings.get();
		return s.resources.map((r) => {
			const c = s.connections.find((c) => c.id === r.connectionId);
			const ok =
				!!c?.enabled &&
				!!settings.credential(c) &&
				s.routes[r.purpose].cloudAllowed;
			return {
				id: `cloud:${r.id}`,
				name: c?.name ?? r.id,
				model: r.model,
				capability: r.purpose,
				protocol: `openai.${r.purpose}`,
				kind: r.purpose,
				source: "cloud",
				onDemand: false,
				primary: true,
				testable: ok,
				reason: ok ? undefined : "invalid_permission",
			};
		});
	}
	function catalog(): ServiceCatalog {
		const s = settings.get();
		const prior = discovered?.catalog;
		return {
			targets: [...(prior?.targets ?? []), ...cloudTargets()],
			errors: prior?.errors ?? [],
			discoveredAt: prior?.discoveredAt ?? null,
			revision: s.revision,
			stale: !prior || prior.revision !== s.revision,
		};
	}
	async function refresh() {
		if (refreshing) return refreshing;
		refreshing = (async () => {
			const s = settings.get();
			const found = await gateway(s).catalog(AbortSignal.timeout(30_000));
			if (settings.get().revision !== s.revision)
				throw new Error("invalid_stale_settings");
			const targets = found.targets.map((t): ServiceTarget => ({
				id: t.id,
				name: t.name,
				model: t.model,
				capability: t.capability,
				protocol: t.protocol,
				kind: t.kind,
				source: "larm",
				onDemand: t.onDemand,
				primary: t.primary,
				testable:
					t.kind !== "unsupported" && (t.mode === "service" || !!t.selector),
				reason:
					t.kind === "unsupported" || (!t.selector && t.mode === "provider")
						? "unsupported_protocol"
						: undefined,
			}));
			discovered = {
				catalog: {
					targets,
					errors: found.errors,
					discoveredAt: found.discoveredAt,
					revision: s.revision,
					stale: false,
				},
				targets: new Map(found.targets.map((t) => [t.id, t])),
			};
			return catalog();
		})().finally(() => {
			refreshing = undefined;
		});
		return refreshing;
	}
	async function reserve(input: {
		requestKey: string;
		hash: string;
		record: RunRecord;
	}) {
		return store.write((db) => {
			if (settings.inTransaction(db).revision !== input.record.revision)
				throw new Error("invalid_stale_settings");
			const old = db
				.query(
					"SELECT id,input_hash FROM service_test_runs WHERE request_key=?",
				)
				.get(input.requestKey) as { id: string; input_hash: string } | null;
			if (old) {
				if (old.input_hash !== input.hash)
					throw new Error("invalid_request_key");
				return { record: readRun(db, old.id)!, fresh: false };
			}
			if (readRuns(db).some((r) => r.status === "running"))
				throw new Error("invalid_test_busy");
			db.query("INSERT INTO service_test_runs VALUES(?,?,?,?,?)").run(
				input.record.id,
				input.requestKey,
				input.hash,
				input.record.created,
				JSON.stringify(input.record),
			);
			db.query(
				"DELETE FROM service_test_runs WHERE id NOT IN (SELECT id FROM service_test_runs ORDER BY created DESC LIMIT 50)",
			).run();
			return { record: input.record, fresh: true };
		});
	}
	const save = (id: string, change: Partial<RunRecord>) =>
		store.write((db) => updateRun(db, id, change));
	function launch(
		record: RunRecord,
		work: (signal: AbortSignal) => Promise<TestOutput | void>,
	) {
		const controller = new AbortController();
		active.set(record.id, controller);
		log.info("service_test.started", { runId: record.id, kind: record.kind });
		const signal = AbortSignal.any([
			controller.signal,
			AbortSignal.timeout(
				record.kind === "music"
					? 30 * 60_000
					: record.kind === "image"
						? 15 * 60_000
						: record.kind === "diagnostics"
							? 10 * 60_000
							: 120_000,
			),
		]);
		const task = (async () => {
			try {
				if (settings.get().revision !== record.revision)
					throw new Error("invalid_stale_settings");
				const output = await work(signal);
				signal.throwIfAborted();
				if (settings.get().revision !== record.revision)
					throw new Error("invalid_stale_settings");
				await store.write((db) => {
					const current = readRun(db, record.id);
					if (current?.status !== "running" || controller.signal.aborted)
						throw new Error("invalid_stale_settings");
					if (output) {
						previews.set(record.id, {
							output,
							expires: Date.now() + 30 * 60_000,
						});
						prune();
					}
					updateRun(db, record.id, {
						status: "succeeded",
						actualModel: output?.actualModel,
						phase: "succeeded",
						ended: Date.now(),
					});
				});
				log.info("service_test.completed", {
					runId: record.id,
					kind: record.kind,
					durationMs: Date.now() - record.created,
				});
			} catch (e) {
				previews.delete(record.id);
				const current = store.read((db) => readRun(db, record.id));
				const error = playgroundError(e);
				const status =
					current?.artifact && !signal.aborted
						? "result-unavailable"
						: error === "generation_unknown" || error === "cancel_unconfirmed"
							? "unknown"
							: signal.aborted
								? "cancelled"
								: record.kind === "music" &&
									  !!current?.jobId &&
									  ["network_unavailable", "deadline_exceeded"].includes(error)
									? "unknown"
									: "failed";
				await save(record.id, {
					status,
					phase: status,
					error,
					ended: Date.now(),
				});
				log.warn("service_test.failed", {
					runId: record.id,
					jobId: current?.jobId,
					reason: error,
				});
			} finally {
				active.delete(record.id);
			}
		})();
		tasks.add(task);
		void task.finally(() => tasks.delete(task)).catch(() => {});
	}
	const unsubscribe = settings.onChange(() => {
		for (const c of active.values()) c.abort();
		previews.clear();
		uploads.clear();
	});
	async function start(raw: StartTest) {
		if (closed) throw new Error("invalid_test_closed");
		const parsed = startSchema.safeParse(raw);
		if (!parsed.success) throw new Error("invalid_test_input");
		const input = parsed.data;
		const s = settings.get();
		if (input.revision !== s.revision || catalog().stale)
			throw new Error("invalid_stale_settings");
		const target = catalog().targets.find((t) => t.id === input.targetId);
		if (!target?.testable) throw new Error("invalid_test_target");
		prune();
		const upload = input.input.uploadId
			? uploads.get(input.input.uploadId)
			: undefined;
		if (input.input.uploadId && !upload) throw new Error("invalid_upload");
		const internal = discovered?.targets.get(target.id);
		const record: RunRecord = {
			id: crypto.randomUUID(),
			targetId: target.id,
			model: target.model,
			kind: target.kind,
			status: "running",
			phase: "preparing",
			created: Date.now(),
			revision: s.revision,
			target: internal,
		};
		const hash = createHash("sha256")
			.update(JSON.stringify({ ...input, requestKey: undefined }))
			.digest("hex");
		const accepted = await reserve({
			requestKey: input.requestKey,
			hash,
			record,
		});
		if (!accepted.fresh) return publicRun(accepted.record);
		launch(record, async (signal) => {
			const progress = async (p: TestProgress) => {
				const current = store.read((db) => readRun(db, record.id));
				if (current?.status !== "running") return;
				await save(record.id, p);
			};
			if (target.source === "cloud") {
				const value = await inference.testResource(
					target.id.slice(6),
					target.kind === "llm"
						? [{ role: "user", content: input.input.text }]
						: target.kind === "asr"
							? (upload?.bytes ?? silentWav())
							: input.input.text,
					signal,
				);
				return typeof value === "string"
					? { text: value }
					: { bytes: value, mime: "audio/wav" };
			}
			const g = gateway(s);
			const fresh = await g.catalog(signal);
			const next = fresh.targets.find((t) => t.id === target.id);
			if (!internal || !next || next.revision !== internal.revision)
				throw new Error("stale_catalog");
			return g.execute(
				next,
				{ ...input.input, audio: upload?.bytes },
				signal,
				progress,
			);
		});
		return publicRun(record);
	}
	async function diagnose() {
		if (closed) throw new Error("invalid_test_closed");
		await refresh();
		const s = settings.get();
		const record: RunRecord = {
			id: crypto.randomUUID(),
			targetId: "diagnostics",
			model: "",
			kind: "diagnostics",
			status: "running",
			phase: "diagnosing",
			created: Date.now(),
			revision: s.revision,
			health: [],
		};
		await reserve({
			requestKey: crypto.randomUUID(),
			hash: "diagnostics",
			record,
		});
		const selected = catalog().targets.filter((t) => t.primary);
		const targets = new Map(discovered?.targets);
		launch(record, async (signal) => {
			const g = gateway(s);
			const controlHealthy = await g.controlHealth(signal).catch(() => false);
			await save(record.id, { controlHealthy });
			const health: HealthRow[] = [];
			for (const t of selected) {
				signal.throwIfAborted();
				const internal = targets.get(t.id);
				const result =
					t.source === "cloud"
						? {
								state: "unsupported" as const,
								reason: t.testable
									? "cloud_health_unsupported"
									: "invalid_permission",
								checkedAt: Date.now(),
							}
						: internal
							? await g.health(
									internal,
									AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
								)
							: {
									state: "unknown" as const,
									reason: "unsupported_protocol",
									checkedAt: Date.now(),
								};
				health.push({
					...result,
					targetId: t.id,
					name: t.name,
					model: t.model,
				});
				await save(record.id, { health: [...health] });
			}
		});
		return publicRun(record);
	}
	async function cancel(id: string) {
		const r = store.read((db) => readRun(db, id));
		if (!r) throw new Error("invalid_test_run");
		if (r.status !== "running") return;
		active.get(id)?.abort();
		previews.delete(id);
		await save(id, { phase: "cancelling" });
	}
	async function retryArtifact(id: string) {
		const r = store.read((db) => readRun(db, id));
		if (
			!r?.artifact ||
			r.revision !== settings.get().revision ||
			!["succeeded", "result-unavailable"].includes(r.status)
		)
			throw new Error("invalid_test_run");
		if (active.size) throw new Error("invalid_test_busy");
		await store.write((db) => {
			if (readRuns(db).some((row) => row.status === "running"))
				throw new Error("invalid_test_busy");
			if (settings.inTransaction(db).revision !== r.revision)
				throw new Error("invalid_stale_settings");
			updateRun(db, id, {
				status: "running",
				phase: "fetching-result",
				ended: undefined,
				error: undefined,
			});
		});
		launch({ ...r, status: "running" }, (signal) =>
			gateway().artifact(r.artifact!, signal),
		);
		return publicRun(store.read((db) => readRun(db, id))!);
	}
	return {
		catalog,
		refresh,
		start,
		diagnose,
		cancel,
		retryArtifact,
		runs: () => store.read((db) => readRuns(db)).map(publicRun),
		run: (id: string) => {
			const r = store.read((db) => readRun(db, id));
			return r ? publicRun(r) : null;
		},
		preview: (id: string) => {
			prune();
			return previews.get(id)?.output;
		},
		upload: (b: Uint8Array) => {
			prune();
			if (
				b.length < 44 ||
				b.length > 4_000_000 ||
				new TextDecoder().decode(b.slice(0, 4)) !== "RIFF" ||
				new TextDecoder().decode(b.slice(8, 12)) !== "WAVE" ||
				uploads.size >= 8
			)
				throw new Error("invalid_upload");
			const id = crypto.randomUUID();
			uploads.set(id, { bytes: b, expires: Date.now() + 30 * 60_000 });
			return { id };
		},
		async recover() {
			const rows = store.read((db) => readRuns(db));
			for (const r of rows)
				if (r.status === "running") {
					if (
						r.kind === "music" &&
						r.jobId &&
						r.target &&
						r.revision === settings.get().revision
					) {
						launch(r, (signal) =>
							gateway().musicJob(r.target!, r.jobId!, signal, (p) =>
								save(r.id, p).then(() => {}),
							),
						);
						continue;
					}
					await save(r.id, {
						status:
							r.kind === "image" || r.kind === "music"
								? "unknown"
								: "interrupted",
						phase: "interrupted",
						ended: Date.now(),
					});
				}
		},
		async close() {
			closed = true;
			unsubscribe();
			for (const c of active.values()) c.abort();
			await Promise.allSettled(tasks);
			previews.clear();
			uploads.clear();
		},
	};
}
export type ServiceTests = ReturnType<typeof createServiceTests>;
