import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { QueueService } from "../queue";
import type { InferencePort } from "../inference";
import type { Host, Work } from "./contracts";
import { capture, decide } from "./decision";
import {
	applyDecision,
	authorityCurrent,
	escalatePendingQuestion,
	finish,
} from "./lifecycle";
import { read, save } from "./repository";

export const DECISION_JOB = "claude-code.decide";
const payload = z.strictObject({ id: z.uuid() });

export function registerDecisionJobs(
	queue: QueueService,
	inference: InferencePort,
	getHost: () => Host | undefined,
	now: () => number,
	kick: () => void,
) {
	queue.registerHandler({
		kind: DECISION_JOB,
		payloadVersions: [1],
		schema: payload,
		recovery: "interrupt",
		prepareInTransaction(db, claim) {
			const host = getHost();
			const work = read(db, claim.payload.id);
			const at = now();
			if (!host || !work || !currentDecision(host, db, work, claim.jobId, at))
				return { status: "stale", reason: "claude_decision_stale" };
			work.calls++;
			if (work.decisionMode === "progress") work.progressCalls++;
			const requestId = capture(db, inference, work, at);
			if (!requestId) throw new Error("claude_decision_unavailable");
			save(db, work, at);
			return { status: "ready", input: { work, requestId } };
		},
		execute: ({ work, requestId }, { signal }) =>
			decide(inference, requestId, work, signal),
		settleInTransaction(db, claim, _input, outcome) {
			const host = getHost();
			const work = read(db, claim.payload.id);
			if (
				!host ||
				!work ||
				!currentDecision(host, db, work, claim.jobId, now())
			)
				return "stale";
			work.decisionId = null;
			if (work.decisionMode === "progress") {
				if (
					outcome.type === "success" &&
					outcome.result.output.action === "wait" &&
					inference.acceptInTransaction?.(db, outcome.result.receipt)
				) {
					work.summary = outcome.result.output.summary;
					work.memo = outcome.result.output.memo;
					work.observedAt = now();
				}
				save(db, work, now());
				return "applied";
			}
			if (work.decisionMode === "question") {
				if (
					outcome.type === "success" &&
					inference.acceptInTransaction?.(db, outcome.result.receipt)
				) {
					work.decisionRetries = 0;
					applyDecision(db, host, work, outcome.result.output, now());
				} else {
					escalatePendingQuestion(work);
				}
				work.observedAt = now();
				save(db, work, now());
				return "applied";
			}
			if (
				outcome.type === "success" &&
				inference.acceptInTransaction?.(db, outcome.result.receipt)
			) {
				work.decisionRetries = 0;
				applyDecision(db, host, work, outcome.result.output, now());
			} else if (outcome.type === "interrupted" && work.calls < work.maxCalls) {
				// Re-scheduled on the next maintenance pass while budget remains.
			} else if (
				!work.supervision &&
				(work.decisionRetries ?? 0) < 2 &&
				work.calls < work.maxCalls
			) {
				work.decisionRetries = (work.decisionRetries ?? 0) + 1;
				work.summary = "判断を再試行しています。";
			} else {
				finish(
					db,
					host,
					work,
					"partial",
					"担当の判断を確定できず、作業を終了しました。",
				);
			}
			work.observedAt = now();
			save(db, work, now());
			return "applied";
		},
		afterCommit: () => kick(),
		cancelInTransaction() {},
	});
}

function currentDecision(
	host: Host,
	db: Database,
	work: Work,
	jobId: string,
	now: number,
) {
	return (
		work.decisionId === jobId &&
		work.status ===
			(work.decisionMode === "progress" ? "waiting_child" : "deciding") &&
		(work.decisionMode !== "question" || !!work.pendingRunnerQuestion) &&
		!work.forgotten &&
		work.deadline > now &&
		authorityCurrent(host, db, work)
	);
}
