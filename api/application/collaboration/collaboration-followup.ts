import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { CollaborationWorks } from "../../domains/collaboration";
import type { QueueService } from "../../domains/queue";

const KIND = "collaboration.followup";
/** Waiting uses the existing queue; no inference slot is held while a domain owns the work. */
export function registerCollaborationFollowup(
	queue: QueueService,
	works: CollaborationWorks,
	afterCommit: () => void,
	now: () => number = Date.now,
) {
	const schedule = (
		db: Database,
		workRef: string,
		requestId: string,
		availableAtMs = now(),
	) => {
		const childId = works.read(db, workRef)?.child_id;
		if (!childId) return;
		return queue.enqueueInTransaction(db, {
			scope: "collaboration",
			kind: KIND,
			payload: { workRef, childId },
			dedupeKey: `collaboration-followup:${requestId}`,
			subjectRef: workRef,
			lane: "background",
			concurrencyKey: `collaboration-work:${workRef}`,
			availableAtMs,
			maxAttempts: 1,
		});
	};
	queue.registerHandler<{ workRef: string; childId: string }, string, void>({
		kind: KIND,
		payloadVersions: [1],
		schema: z.strictObject({ workRef: z.uuid(), childId: z.uuid() }),
		recovery: "replay_safe",
		prepareInTransaction(db, claim) {
			return works.read(db, claim.payload.workRef)?.child_id ===
				claim.payload.childId && works.pending(db, claim.payload.workRef)
				? { status: "ready", input: claim.payload.workRef }
				: { status: "stale", reason: "collaboration_not_pending" };
		},
		async execute() {},
		settleInTransaction(db, claim, workRef, outcome) {
			if (outcome.type !== "success" || !workRef) return "stale";
			if (works.read(db, workRef)?.child_id !== claim.payload.childId)
				return "stale";
			works.refresh(db, workRef);
			if (works.pending(db, workRef))
				schedule(db, workRef, `${claim.jobId}:next`, now() + 2000);
			return "applied";
		},
		cancelInTransaction() {},
		afterCommit() {
			afterCommit();
			queue.wake();
		},
	});
	return schedule;
}
