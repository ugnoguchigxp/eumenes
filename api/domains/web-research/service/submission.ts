import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { QueueService } from "../../queue";
import { submitResearchSchema, type ResearchRequest } from "../contracts";
import { byRequest, insert } from "../repository";
import { cacheKey } from "./cache";
const KIND = "web-research.acquire";
export const requestDigest = (request: ResearchRequest) => {
	const { requestId: _id, ...input } = request;
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
};
/** Synchronous acceptance and durable caller budgets; no acquisition happens in the writer. */
export function createWebSubmission(
	queue: QueueService,
	now: () => number,
	id: () => string,
	isClosing: () => boolean,
	acquisitionTimeoutMs: number,
) {
	return function submitInTransaction(
		db: Database,
		raw: unknown,
		hostOptions?: {
			deadlineAtMs: number;
			parentJobId?: string;
			lane: "interactive" | "background";
			availableAtMs?: number;
			/** 1..15000 ms, counted from execute start (never from Queue admission). */
			attemptTimeoutMs?: number;
			/** Host-owned total acquisition + semantic review bound; default remains 30 seconds. */
			acquisitionTimeoutMs?: number;
		},
	) {
		if (isClosing()) throw new Error("web_research_unavailable");
		const acquisitionMs = hostOptions?.acquisitionTimeoutMs;
		if (
			acquisitionMs !== undefined &&
			(!Number.isSafeInteger(acquisitionMs) ||
				acquisitionMs < 1 ||
				acquisitionMs > 120000)
		)
			throw new Error("invalid_web_acquisition_timeout");
		const attemptTimeoutMs = hostOptions?.attemptTimeoutMs;
		if (
			attemptTimeoutMs !== undefined &&
			(!Number.isSafeInteger(attemptTimeoutMs) ||
				attemptTimeoutMs < 1 ||
				attemptTimeoutMs > 15000)
		)
			throw new Error("invalid_web_attempt_timeout");
		const parsed = submitResearchSchema.safeParse(raw);
		if (!parsed.success) throw new Error("invalid_web_research_input");
		const request = parsed.data,
			inputDigest = requestDigest(request);
		return (() => {
			const existing = byRequest(db, request.requestId);
			if (existing) {
				if (
					existing.input_digest !== inputDigest ||
					(existing.acquisition_timeout_ms ?? acquisitionTimeoutMs) !==
						(acquisitionMs ?? acquisitionTimeoutMs)
				)
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
				availableAtMs: hostOptions?.availableAtMs,
				parentJobId: hostOptions?.parentJobId,
				deadlineAtMs: Math.min(
					Math.max(now(), hostOptions?.availableAtMs ?? 0) +
						(acquisitionMs ?? 30000),
					hostOptions?.deadlineAtMs ?? Infinity,
				),
				maxAttempts: 1,
				// Serialize cache writes for a URL, including fresh bypasses, so older fetches cannot replace newer content.
				concurrencyKey: cacheKey(request) ?? undefined,
			});
			insert(
				db,
				runId,
				request,
				inputDigest,
				job.job.id,
				now(),
				attemptTimeoutMs,
				acquisitionMs,
			);
			return { runId, jobId: job.job.id, fresh: true };
		})();
	};
}
