import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import {
	DECISIONS_PER_CONVERSATION,
	MAX_FAILURES,
	UNITS_PER_CONVERSATION,
} from "../contracts";
import {
	type UnitRow,
	bumpEventFailure,
	bumpGoalTodoFailure,
	bumpInboxFailure,
	bumpWorldEvent,
	closeUnit,
	deleteEventFailures,
	deleteGoalTodos,
	deleteWorldEvents,
	insertDecision,
	insertDecisionRefs,
	pruneDecisions,
	pruneUnits,
	readState,
	resolveInbox,
	writeState,
} from "../repository";
import type { Kick } from "./kick";
import { REQUEST_FAILED_NOTICE } from "./notices";
import { rangeKey } from "./episode-plan";
import type { ApplyResult, StepEnv, StewardDeps } from "./types";
import { type Wake, retryDelay } from "./wake";

const log = getLogger("steward");

/** How a unit ends: released requests, failure counts, the decision record and the upkeep control. */
export function createUnitEnd(deps: StewardDeps, kick: Kick, wake: Wake) {
	const { store, inference, memory } = deps;
	const cancelled = new Set<string>();
	store.onCommit(() => {
		if (cancelled.size === 0) return;
		const ids = [...cancelled];
		cancelled.clear();
		inference.flushCancelledRequests(ids);
	});

	/** The request goes with the job, whatever way it ended (cancelled, then flushed after the commit). */
	function release(db: Database, requestIds: readonly string[]) {
		if (requestIds.length === 0) return;
		inference.cancelRequestsInTransaction(db, [...requestIds]);
		for (const id of requestIds) cancelled.add(id);
	}

	function record(
		env: StepEnv,
		unit: UnitRow,
		fields: {
			jobId: string;
			output?: unknown;
			results?: unknown;
			errorCode?: string | null;
			durationMs?: number | null;
			outputTokens?: number | null;
			after?: number | null;
			refs?: ApplyResult["refs"];
		},
		before: number | null,
	) {
		const { db } = env;
		const id = insertDecision(db, {
			conversationId: unit.conversationId,
			jobId: fields.jobId,
			step: unit.step,
			createdAt: deps.clock(),
			output: fields.output ?? null,
			results: fields.results ?? null,
			windowVersionBefore: before,
			windowVersionAfter: fields.after ?? null,
			durationMs: fields.durationMs ?? null,
			outputTokens: fields.outputTokens ?? null,
			errorCode: fields.errorCode ?? null,
		});
		if (fields.refs) insertDecisionRefs(db, id, fields.refs);
		pruneDecisions(db, unit.conversationId, DECISIONS_PER_CONVERSATION);
		pruneUnits(db, unit.conversationId, UNITS_PER_CONVERSATION);
	}

	/** One more failed try over each target; at the limit a target is given up (section 2.3). */
	function countFailures(env: StepEnv, unit: UnitRow) {
		const { db } = env;
		const now = deps.clock();
		const { conversationId } = unit;
		// An event that failed three times is given up: it is marked handled, and later events are not held back.
		if (unit.step === "curate-memory")
			for (const seq of unit.targets.seqs ?? [])
				if (bumpEventFailure(db, conversationId, seq) >= MAX_FAILURES) {
					deps.continuity.events.markCuratedInTransaction(db, conversationId, [
						seq,
					]);
					deleteEventFailures(db, conversationId, [seq]);
				}
		if (unit.step === "curate-goals")
			for (const seq of unit.targets.seqs ?? [])
				if (bumpGoalTodoFailure(db, conversationId, seq) >= MAX_FAILURES)
					deleteGoalTodos(db, conversationId, [seq]);
		const world = deps.world;
		if (unit.kind === "world_events" && world) {
			// An event that failed three times is given up (`STEWARD_GAVE_UP`); later events are not held back by it.
			const exhausted = (unit.targets.events ?? []).filter(
				(id) => bumpWorldEvent(db, id, "failures") >= MAX_FAILURES,
			);
			if (exhausted.length > 0) {
				world.curation.giveUpEventsInTransaction(db, world.scope, exhausted);
				deleteWorldEvents(db, exhausted);
			}
		}
		let given = 0;
		for (const id of unit.targets.requests ?? [])
			if (bumpInboxFailure(db, id) >= MAX_FAILURES) {
				resolveInbox(db, id, "none", "steward_failed", now);
				given++;
			}
		// The user asked for something and is told it could not be done.
		if (given > 0 && memory.readyInTransaction(db))
			memory.publishWindowInTransaction(db, unit.conversationId, {
				addNotices: [REQUEST_FAILED_NOTICE],
			});
	}

	/** The recall preparation for this event is over (done, given up, or unreadable). */
	function dropRecall(db: Database, unit: UnitRow) {
		const state = readState(db, unit.conversationId);
		if (state.recallPending === unit.targets.recallSeq)
			writeState(db, { ...state, recallPending: null });
	}

	/** What a World unit's prepare registered with Memory is given back, whatever way the unit ended. Idempotent. */
	function releaseWorld(db: Database, unit: UnitRow) {
		const world = deps.world;
		if (unit.kind !== "world_events" || !world) return;
		world.curation.releaseCurationInTransaction(
			db,
			world.scope,
			unit.targets.events ?? [],
		);
	}

	function failUnit(
		env: StepEnv,
		unit: UnitRow,
		jobId: string,
		code: string,
		count: boolean,
		details: { durationMs?: number; outputTokens?: number | null } = {},
	) {
		const { db } = env;
		if (!closeUnit(db, unit.id, "failed", deps.clock())) return;
		releaseWorld(db, unit);
		if (count) {
			countFailures(env, unit);
			// The same targets wait before the next try (the timer kicks when it is over; nothing is enqueued for later).
			wake.pause(
				unit.conversationId,
				unit.slot,
				deps.nowMs() + retryDelay(unit.attempt + 1),
			);
		}
		// The recall preparation is a side step: it is not tried again.
		if (unit.slot === "recall") dropRecall(db, unit);
		record(env, unit, { jobId, errorCode: code, ...details }, null);
		log.warn("steward.unit_failed", { stepId: unit.step, reason: code, jobId });
		kick.kickOne(db, unit.conversationId);
	}

	function staleUnit(
		env: StepEnv,
		unit: UnitRow,
		jobId: string,
		reason: string,
	) {
		const { db } = env;
		if (!closeUnit(db, unit.id, "stale", deps.clock())) return;
		releaseWorld(db, unit);
		record(env, unit, { jobId, errorCode: reason }, null);
		log.info("steward.unit_stale", { stepId: unit.step, reason, jobId });
		kick.kickOne(db, unit.conversationId);
	}

	/** An upkeep step with nothing to look at stays quiet until the revision moves. */
	function markQuiet(db: Database, unit: UnitRow) {
		const state = readState(db, unit.conversationId);
		const revision = unit.targets.revision ?? state.maintenanceRevision;
		writeState(db, {
			...state,
			quiet: {
				...state.quiet,
				quiet: { ...state.quiet.quiet, [unit.step]: revision },
			},
		});
	}

	/** An episode range with nothing to prepare is remembered, so the kick does not make it into a unit again. */
	function markEpisodeQuiet(db: Database, unit: UnitRow) {
		const range = unit.targets.range;
		if (!range) return;
		const state = readState(db, unit.conversationId);
		const key = rangeKey(unit.step, range);
		const known = state.quiet.episode ?? [];
		if (known.includes(key)) return;
		writeState(db, {
			...state,
			quiet: { ...state.quiet, episode: [...known, key].slice(-100) },
		});
	}

	/** The upkeep control after an adopted step. */
	function settleState(env: StepEnv, unit: UnitRow, applied: ApplyResult) {
		const { db } = env;
		const state = readState(db, unit.conversationId);
		if (applied.changed) state.maintenanceRevision += 1;
		if (unit.step === "curate-memory" && (unit.targets.seqs?.length ?? 0) > 0)
			state.recallPending = Math.max(...unit.targets.seqs!);
		if (
			unit.slot === "recall" &&
			state.recallPending === unit.targets.recallSeq
		)
			state.recallPending = null;
		if (unit.slot === "maintenance" && applied.quiet) {
			const revision = unit.targets.revision ?? state.maintenanceRevision;
			state.quiet = {
				...state.quiet,
				quiet: { ...state.quiet.quiet, [unit.step]: revision },
			};
		}
		writeState(db, state);
	}

	return {
		release,
		releaseWorld,
		record,
		failUnit,
		staleUnit,
		markQuiet,
		markEpisodeQuiet,
		settleState,
		dropRecall,
	};
}
export type UnitEnd = ReturnType<typeof createUnitEnd>;
