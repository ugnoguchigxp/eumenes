import type { Database } from "bun:sqlite";
import type { ScopeRef } from "eumenes-world-model";
import {
	listExtractEventsByIds,
	listOpenExtractEvents,
	settleExtractEvent,
} from "../repository/extraction";
import { createAdoption } from "./curation-adopt";
import { createCurationCtx } from "./curation-ctx";
import { createForget } from "./curation-forget";
import { createPrepare } from "./curation-prepare";
import { createSettle } from "./curation-settle";
import type { CurationOptions, PendingCurationEvent } from "./curation-types";

export {
	CURATION_INTERPRETATION_VERSION,
	CurationError,
	WORLD_CURATE_PURPOSE,
} from "./curation-ctx";
export type * from "./curation-types";
export { CURATION_LIMITS } from "./curation-types";
export { curationOutputShapeSchema } from "./curation-output";

/** Events listed per call at most. */
const PENDING_MAX = 200;

/**
 * The World half of the steward's `curate-world` step. Every operation runs inside the
 * transaction its caller owns; a thrown error means "roll that transaction back".
 */
export function createWorldCuration(options: CurationOptions) {
	const ctx = createCurationCtx(options);
	const adoption = createAdoption(ctx);
	const forget = createForget(ctx);

	return {
		/**
		 * Received, unsettled events the steward may curate now, oldest first: not held (a window
		 * that was held is offered again only after the entities changed) and with a known conversation
		 * (events received before the steward existed carry none and never block). With a
		 * `conversationId` only that conversation's events are read.
		 */
		pendingEventsInTransaction(
			db: Database,
			scope: ScopeRef,
			limit: number,
			conversationId?: string,
		): PendingCurationEvent[] {
			return listOpenExtractEvents(db, scope.principal, scope.scopeKey, {
				digest: ctx.entityDigest(db, scope),
				conversationId,
				limit: Math.min(PENDING_MAX, Math.max(0, limit)),
			}).map((row) => ({
				eventId: row.eventId,
				messageId: row.source.id,
				revision: row.source.revision,
				digest: row.source.digest,
				speaker: row.speaker,
				conversationId: row.conversationId as string,
				seq: row.seq,
			}));
		},

		prepareCurationInTransaction: createPrepare(ctx),
		settleCurationInTransaction: createSettle(ctx, adoption),

		/**
		 * Events the steward routed out (nothing about the world in them): settled `applied` with no
		 * candidates, so the applied position moves on. No model saw them, so no Memory dependents.
		 */
		settleEmptyInTransaction(
			db: Database,
			scope: ScopeRef,
			eventIds: readonly string[],
		): string[] {
			const settled: string[] = [];
			for (const row of listExtractEventsByIds(
				db,
				scope.principal,
				scope.scopeKey,
				eventIds,
			)) {
				if (row.state !== "received") continue;
				ctx.releaseEvents(db, scope, [row.eventId]);
				ctx.settleOp(db, scope, row, {
					disposition: "applied",
					manifest: { manifestId: `xm-empty-${row.eventId}`, dependencies: [] },
					assertions: [],
					appliedCursor: row.receivedCursor,
				});
				settleExtractEvent(
					db,
					scope.principal,
					scope.scopeKey,
					row.eventId,
					"applied",
					"ROUTED_EMPTY",
					ctx.now(),
				);
				settled.push(row.eventId);
			}
			return settled;
		},

		/**
		 * The steward gave up on events it could not place after repeated tries: `rejected`, final.
		 * Later events are not held back by them.
		 */
		giveUpEventsInTransaction(
			db: Database,
			scope: ScopeRef,
			eventIds: readonly string[],
		): string[] {
			const settled: string[] = [];
			for (const row of listExtractEventsByIds(
				db,
				scope.principal,
				scope.scopeKey,
				eventIds,
			)) {
				if (row.state !== "received") continue;
				ctx.releaseEvents(db, scope, [row.eventId]);
				ctx.rejectEvent(db, scope, row, "STEWARD_GAVE_UP");
				settled.push(row.eventId);
			}
			return settled;
		},

		/**
		 * Gives back the Memory dependents a prepare registered when its result was not settled (the
		 * step failed, timed out or was cancelled). Idempotent.
		 */
		releaseCurationInTransaction(
			db: Database,
			scope: ScopeRef,
			eventIds: readonly string[],
		): void {
			ctx.releaseEvents(db, scope, eventIds);
		},

		...forget,
	};
}
export type WorldCuration = ReturnType<typeof createWorldCuration>;
