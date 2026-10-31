import { createTestControls } from "./controls";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { getLogger } from "../../../infrastructure/logger";
import {
	createLarmPlayground,
	playgroundError,
	type LarmPlayground,
	type LarmTestTarget,
	type TestOutput,
} from "../../larm";
import type { SettingsService } from "../../settings";
import type { InferenceService } from "../../inference";
import {
	startSchema,
	type ServiceCatalog,
	type ServiceTarget,
	type ServiceRun,
} from "../contracts";
import { readRun, readRuns, updateRun, type RunRecord } from "../repository";
import { diagnoseWork, startWork, type Work, type WorkDeps } from "./works";

const startInTransactionSchema = startSchema.extend({
	revision: z.number().int().nonnegative().optional(),
});

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
	const controls = createTestControls(store, active, previews);
	const { cancelInTransaction } = controls;
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
			targets: [...(prior?.targets ?? []), ...cloudTargets()].map(
				controls.target,
			),
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
	type Reservation = { requestKey: string; hash: string; record: RunRecord };
	function reserveInTransaction(db: Database, input: Reservation) {
		if (settings.inTransaction(db).revision !== input.record.revision)
			throw new Error("invalid_stale_settings");
		const old = db
			.query("SELECT id,input_hash FROM service_test_runs WHERE request_key=?")
			.get(input.requestKey) as { id: string; input_hash: string } | null;
		if (old) {
			if (old.input_hash !== input.hash) throw new Error("invalid_request_key");
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
				store.read((db) => controls.assertAllowed(db, record.kind));
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
	const workDeps: WorkDeps = {
		store,
		save,
		inference,
		gateway,
		uploads,
		refresh,
		catalog,
		targets: () => discovered?.targets,
	};
	/**
	 * A run accepted in a writer transaction; `launch` starts its work once that commits. It
	 * returns false while the run's row is not committed yet (it may be called again later).
	 */
	type Accepted = { run: ServiceRun; launch?: () => boolean };
	/** Start the work only if its running row committed (a rolled-back reservation never runs). */
	function launchCommitted(record: RunRecord, work: Work) {
		if (closed) return true;
		if (store.read((db) => readRun(db, record.id))?.status !== "running")
			return false;
		launch(record, work);
		return true;
	}
	/**
	 * `revision` is the settings revision the person saw; without it only the catalog's own
	 * stale check applies (settings changed since the last discovery).
	 */
	function startInTransaction(
		db: Database,
		raw: Omit<z.input<typeof startSchema>, "revision"> & { revision?: number },
	): Accepted {
		if (closed) throw new Error("invalid_test_closed");
		const parsed = startInTransactionSchema.safeParse(raw);
		if (!parsed.success) throw new Error("invalid_test_input");
		const input = parsed.data;
		const s = settings.inTransaction(db);
		if (
			(input.revision !== undefined && input.revision !== s.revision) ||
			catalog().stale
		)
			throw new Error("invalid_stale_settings");
		const target = catalog().targets.find((t) => t.id === input.targetId);
		if (target) controls.assertAllowed(db, target.kind);
		if (!target?.testable) throw new Error("invalid_test_target");
		prune();
		if (input.input.uploadId && !uploads.has(input.input.uploadId))
			throw new Error("invalid_upload");
		const record: RunRecord = {
			id: crypto.randomUUID(),
			targetId: target.id,
			model: target.model,
			kind: target.kind,
			status: "running",
			phase: "preparing",
			created: Date.now(),
			revision: s.revision,
			target: discovered?.targets.get(target.id),
		};
		const hash = createHash("sha256")
			.update(JSON.stringify({ ...input, requestKey: undefined }))
			.digest("hex");
		const accepted = reserveInTransaction(db, {
			requestKey: input.requestKey,
			hash,
			record,
		});
		if (!accepted.fresh) return { run: publicRun(accepted.record) };
		const work = startWork(workDeps, record, input.input, target, s);
		return {
			run: publicRun(record),
			launch: () => launchCommitted(record, work),
		};
	}
	/**
	 * The catalog is refreshed by the launched work, not before the run is recorded: the
	 * writer transaction cannot wait for the network.
	 */
	function diagnoseInTransaction(
		db: Database,
		requestKey: string = crypto.randomUUID(),
	): Accepted {
		if (closed) throw new Error("invalid_test_closed");
		const s = settings.inTransaction(db);
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
		const accepted = reserveInTransaction(db, {
			requestKey,
			hash: "diagnostics",
			record,
		});
		if (!accepted.fresh) return { run: publicRun(accepted.record) };
		return {
			run: publicRun(record),
			launch: () => launchCommitted(record, diagnoseWork(workDeps, record, s)),
		};
	}
	function retryArtifactInTransaction(db: Database, id: string): Accepted {
		const r = readRun(db, id);
		if (
			!r?.artifact ||
			r.revision !== settings.inTransaction(db).revision ||
			!["succeeded", "result-unavailable"].includes(r.status)
		)
			throw new Error("invalid_test_run");
		if (active.size || readRuns(db).some((row) => row.status === "running"))
			throw new Error("invalid_test_busy");
		const running = updateRun(db, id, {
			status: "running",
			phase: "fetching-result",
			ended: undefined,
			error: undefined,
		});
		return {
			run: publicRun(running),
			launch: () =>
				launchCommitted(running, (signal) =>
					gateway().artifact(r.artifact!, signal),
				),
		};
	}
	return {
		catalog,
		refresh,
		setVoiceAvailability: controls.setVoiceAvailability,
		pauseVoice: controls.pauseVoice,
		startInTransaction,
		diagnoseInTransaction,
		cancelInTransaction,
		retryArtifactInTransaction,
		runsInTransaction: (db: Database) => readRuns(db).map(publicRun),
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
