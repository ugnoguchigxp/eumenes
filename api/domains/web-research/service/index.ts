import { createHash } from "node:crypto";
import { z } from "zod";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { HandlerDefinition, QueueService } from "../../queue";
import { getLogger } from "../../../infrastructure/logger";
import {
	submitResearchSchema,
	resultSchema,
	type ResearchRequest,
	type ResearchRun,
	type ResearchResult,
} from "../contracts";
import {
	byId,
	byRequest,
	insert,
	finish,
	running,
	sweepRuns,
} from "../repository";
import {
	createWebAcquisition,
	acquisitionError,
	type AcquisitionPort,
	type Acquisition,
} from "../adapters/llm-fetch";
import { cacheKey, type WebCache, type CacheHit } from "./cache";

const KIND = "web-research.acquire";
const log = getLogger("web-research");
interface Prepared {
	id: string;
	request: ResearchRequest;
	generation: number;
	hit: CacheHit | null;
}
interface Executed extends Acquisition {
	hit: CacheHit | null;
}
const digest = (request: ResearchRequest) => {
	const { requestId: _id, ...input } = request;
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
};
function boundResult(result: ResearchResult): ResearchResult {
	const parsed = resultSchema.parse(result);
	const documents = parsed.documents.map((doc) => ({ ...doc, text: "" }));
	let rawRemaining = 24000;
	let encodedRemaining =
		32 * 1024 - Buffer.byteLength(JSON.stringify({ ...parsed, documents }));
	if (encodedRemaining < 0) throw new Error("web_result_too_large");
	for (let i = 0; i < documents.length; i++) {
		const original = parsed.documents[i]!;
		const chunks: string[] = [];
		for (const character of original.text) {
			const bytes = Buffer.byteLength(character),
				encoded = Buffer.byteLength(JSON.stringify(character)) - 2;
			if (bytes > rawRemaining || encoded > encodedRemaining) break;
			chunks.push(character);
			rawRemaining -= bytes;
			encodedRemaining -= encoded;
		}
		const text = chunks.join("");
		documents[i] = {
			...original,
			text,
			truncated: original.truncated || text !== original.text,
		};
	}
	return { ...parsed, documents };
}

export function createWebResearch({
	store,
	queue,
	cache,
	acquisition = createWebAcquisition(),
	now = Date.now,
	id = () => crypto.randomUUID(),
	acquisitionTimeoutMs = 15000,
}: {
	store: SqliteStore;
	queue: QueueService;
	cache?: WebCache;
	acquisition?: AcquisitionPort;
	now?: () => number;
	id?: () => string;
	acquisitionTimeoutMs?: number;
}) {
	if (
		!Number.isSafeInteger(acquisitionTimeoutMs) ||
		acquisitionTimeoutMs < 1 ||
		acquisitionTimeoutMs > 30000
	)
		throw new Error("invalid_web_timeout");
	// Delivery buffer, not a persistent search cache. Completed results expire after 15 minutes.
	const results = new Map<string, { value: ResearchResult; expires: number }>();
	const shares = new Map<
		string,
		{
			controller: AbortController;
			promise: Promise<Acquisition>;
			users: number;
		}
	>();
	const writes = new Set<Promise<unknown>>();
	let closing = false,
		timer: ReturnType<typeof setInterval> | undefined,
		sweeping: Promise<void> | null = null,
		closeTask: Promise<void> | null = null;
	function prune() {
		for (const [key, value] of results)
			if (value.expires <= now()) results.delete(key);
		while (results.size > 64) results.delete(results.keys().next().value!);
	}
	function rememberWrite(task: Promise<unknown>) {
		writes.add(task);
		void task.finally(() => writes.delete(task)).catch(() => {});
	}
	function shared(input: Prepared, signal: AbortSignal): Promise<Acquisition> {
		signal.throwIfAborted();
		const key = `${input.generation}:${digest(input.request)}`;
		let work = shares.get(key);
		if (!work || work.controller.signal.aborted) {
			const controller = new AbortController();
			const deadline = AbortSignal.any([
				controller.signal,
				AbortSignal.timeout(acquisitionTimeoutMs),
			]);
			const promise = new Promise<Acquisition>((resolve, reject) => {
				const aborted = () =>
					reject(
						new Error(
							controller.signal.aborted ? "web_cancelled" : "web_timeout",
						),
					);
				deadline.addEventListener("abort", aborted, { once: true });
				const fetch = Promise.resolve().then(() => {
					deadline.throwIfAborted();
					return acquisition.execute(input.request, deadline);
				});
				void fetch
					.then(resolve, reject)
					.finally(() => deadline.removeEventListener("abort", aborted));
			});
			work = { controller, promise, users: 0 };
			shares.set(key, work);
			const created = work;
			void promise.then(
				() => {
					if (shares.get(key) === created) shares.delete(key);
				},
				() => {
					if (shares.get(key) === created) shares.delete(key);
				},
			);
		}
		const active = work;
		active.users++;
		return new Promise((resolve, reject) => {
			let released = false;
			const release = () => {
				if (released) return;
				released = true;
				signal.removeEventListener("abort", abort);
				if (--active.users === 0) {
					active.controller.abort();
					if (shares.get(key) === active) shares.delete(key);
				}
			};
			const abort = () => {
				release();
				reject(new Error("web_cancelled"));
			};
			signal.addEventListener("abort", abort, { once: true });
			active.promise.then(
				(value) => {
					release();
					resolve(value);
				},
				(error) => {
					release();
					reject(error);
				},
			);
		});
	}
	const handler: HandlerDefinition<{ runId: string }, Prepared, Executed> = {
		kind: KIND,
		payloadVersions: [1],
		schema: z.object({ runId: z.string().uuid() }),
		recovery: "interrupt",
		resourceKey: "web.fetch",
		prepareInTransaction(db, claim) {
			const run = byId(db, claim.payload.runId);
			if (!run || run.status !== "queued" || closing)
				return { status: "stale", reason: "web_run_stale" };
			const request = submitResearchSchema.parse(JSON.parse(run.input_json));
			if (!running(db, run.id))
				return { status: "stale", reason: "web_run_stale" };
			let generation = -1,
				hit: CacheHit | null = null;
			try {
				if (cacheKey(request)) {
					generation = cache?.generation() ?? -1;
					hit = cache?.get(request) ?? null;
				}
			} catch {
				log.warn("web.cache_unavailable", { reason: "cache_read_failed" });
			}
			return {
				status: "ready",
				input: { id: run.id, request, generation, hit },
			};
		},
		async execute(input, context) {
			try {
				if (input.hit)
					return {
						result: boundResult(input.hit.result),
						freshUntilMs: null,
						hit: input.hit,
					};
				const value = await shared(input, context.signal);
				context.signal.throwIfAborted();
				return {
					...value,
					result: boundResult({
						...value.result,
						cache:
							input.request.operation === "read" &&
							input.request.retention === "stable" &&
							input.request.freshness === "normal"
								? "miss"
								: "bypass",
					}),
					hit: null,
				};
			} catch (error) {
				throw new Error(acquisitionError(error));
			}
		},
		settleInTransaction(db, claim, input, outcome) {
			const runId = claim.payload.runId;
			if (outcome.type === "success" && input) {
				const value = outcome.result;
				if (cache && input.generation >= 0) {
					try {
						const current = value.hit ? cache.get(input.request) : null;
						if (
							cache.generation() !== input.generation ||
							(value.hit &&
								(!current ||
									current.retentionRevision !== value.hit.retentionRevision))
						) {
							finish(db, runId, "failed", now(), "web_cache_changed");
							return { status: "failed", errorCode: "web_cache_changed" };
						}
					} catch {
						if (value.hit) {
							finish(db, runId, "failed", now(), "web_cache_unavailable");
							return { status: "failed", errorCode: "web_cache_unavailable" };
						}
					}
				}
				const partial = value.result.failures.length > 0;
				if (!finish(db, runId, partial ? "partial" : "completed", now()))
					return "stale";
				// Publish only after Queue's synchronous transaction commits. A rollback cannot evict another delivery.
				const task = Promise.resolve()
					.then(async () => {
						if (
							closing ||
							!["completed", "partial"].includes(
								byIdRead(runId)?.status ?? "",
							) ||
							queue.get(claim.jobId)?.state !== "completed"
						)
							return;
						results.set(runId, {
							value: boundResult(value.result),
							expires: now() + 15 * 60000,
						});
						prune();
						log.info("web.completed", {
							runId,
							jobId: claim.jobId,
							status: partial ? "partial" : "completed",
						});
						if (!cache) return;
						if (value.hit) await cache.use(value.hit);
						else if (!partial && input.generation >= 0)
							await cache.put(
								input.request,
								value.result,
								value.freshUntilMs,
								input.generation,
							);
					})
					.catch(() =>
						log.warn("web.cache_unavailable", {
							runId,
							jobId: claim.jobId,
							reason: "cache_write_failed",
						}),
					);
				rememberWrite(task);
				return "applied";
			}
			const state = outcome.type === "interrupted" ? "interrupted" : "failed";
			const code =
				outcome.type === "failed" ||
				outcome.type === "interrupted" ||
				outcome.type === "retry"
					? outcome.errorCode
					: outcome.type === "expired"
						? "web_deadline_exceeded"
						: "web_run_stale";
			return finish(db, runId, state, now(), code) ? "applied" : "stale";
		},
		cancelInTransaction(db, job) {
			finish(db, job.payload.runId, "cancelled", now(), "cancel_requested");
		},
	};
	queue.registerHandler(handler);
	const byIdRead = (runId: string) => store.read((db) => byId(db, runId));
	function get(runId: string): ResearchRun | null {
		prune();
		const row = byIdRead(runId);
		if (!row) return null;
		const value = ["completed", "partial"].includes(row.status)
			? (results.get(runId)?.value ?? null)
			: null;
		return {
			id: row.id,
			requestId: row.request_id,
			jobId: row.job_id,
			operation: row.operation,
			status: row.status,
			createdAt: new Date(row.created_at_ms).toISOString(),
			finishedAt:
				row.finished_at_ms === null
					? null
					: new Date(row.finished_at_ms).toISOString(),
			errorCode: row.error_code,
			result: value,
			resultExpired:
				["completed", "partial"].includes(row.status) && value === null,
		};
	}
	async function sweep() {
		if (sweeping) return sweeping;
		sweeping = (async () => {
			prune();
			await store.write((db) => sweepRuns(db, now()));
			try {
				await cache?.sweep();
			} catch {
				log.warn("web.cache_unavailable", { reason: "cache_sweep_failed" });
			}
		})().finally(() => {
			sweeping = null;
		});
		return sweeping;
	}
	function submitInTransaction(
		db: import("bun:sqlite").Database,
		raw: unknown,
		hostOptions?: {
			deadlineAtMs: number;
			parentJobId: string;
			lane: "interactive" | "background";
		},
	) {
		if (closing) throw new Error("web_research_unavailable");
		const parsed = submitResearchSchema.safeParse(raw);
		if (!parsed.success) throw new Error("invalid_web_research_input");
		const request = parsed.data,
			inputDigest = digest(request);
		return (() => {
			const existing = byRequest(db, request.requestId);
			if (existing) {
				if (existing.input_digest !== inputDigest)
					throw new Error("request_conflict");
				return { runId: existing.id, jobId: existing.job_id, fresh: false };
			}
			const runId = id();
			const job = queue.enqueueInTransaction(db, {
				scope: "web:owner",
				kind: KIND,
				dedupeKey: request.requestId,
				payload: { runId },
				subjectRef: runId,
				lane: hostOptions?.lane ?? "background",
				parentJobId: hostOptions?.parentJobId,
				deadlineAtMs: Math.min(
					now() + 30000,
					hostOptions?.deadlineAtMs ?? Infinity,
				),
				maxAttempts: 1,
				// Serialize cache writes for a URL, including fresh bypasses, so older fetches cannot replace newer content.
				concurrencyKey: cacheKey(request) ?? undefined,
			});
			insert(db, runId, request, inputDigest, job.job.id, now());
			return { runId, jobId: job.job.id, fresh: true };
		})();
	}
	function cancelInTransaction(
		db: import("bun:sqlite").Database,
		runId: string,
		reason: string,
	) {
		const run = byId(db, runId);
		if (!run) return [];
		queue.cancelInTransaction(db, run.job_id, reason);
		return [run.job_id];
	}
	return {
		submitInTransaction,
		cancelInTransaction,
		async submit(raw: unknown) {
			const result = await store.write((db) => submitInTransaction(db, raw));
			queue.wake();
			return get(result.runId)!;
		},
		get,
		async cancel(runId: string) {
			const run = byIdRead(runId);
			if (!run) return null;
			await queue.cancel(run.job_id);
			return get(runId);
		},
		cacheStatus: () => {
			try {
				return (
					cache?.status() ?? {
						enabled: false,
						entries: 0,
						bytes: 0,
						generation: -1,
						lastSweepAt: null,
					}
				);
			} catch {
				return {
					enabled: false,
					entries: 0,
					bytes: 0,
					generation: -1,
					lastSweepAt: null,
				};
			}
		},
		async clearCache() {
			if (!cache) throw new Error("web_cache_unavailable");
			await cache.clear();
			return { cleared: true };
		},
		sweep,
		async recover() {
			await store.write((db) =>
				db
					.query(
						"UPDATE web_research_runs SET status='interrupted', finished_at_ms=?, error_code='outcome_unknown' WHERE status='running'",
					)
					.run(now()),
			);
			await sweep();
		},
		start() {
			if (timer || closing) return;
			timer = setInterval(
				() =>
					void sweep().catch(() => {
						log.warn("web.sweep_failed", { reason: "maintenance_failed" });
					}),
				3600000,
			);
			timer.unref();
		},
		close() {
			if (closeTask) return closeTask;
			closing = true;
			if (timer) clearInterval(timer);
			for (const work of shares.values()) work.controller.abort();
			closeTask = (async () => {
				await Promise.allSettled([sweeping]);
				await Promise.allSettled(writes);
				results.clear();
				const closed = await Promise.allSettled([
					Promise.resolve().then(() => acquisition.close()),
					Promise.resolve().then(() => cache?.close()),
				]);
				if (closed.some((result) => result.status === "rejected"))
					log.warn("web.close_failed", { reason: "resource_close_failed" });
			})();
			return closeTask;
		},
	};
}
export type WebResearchService = ReturnType<typeof createWebResearch>;
