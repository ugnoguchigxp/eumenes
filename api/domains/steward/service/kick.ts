import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import { PENDING_LIMIT } from "../../memory";
import {
	EXCHANGES_PER_UNIT,
	JOB_DEADLINE_MS,
	MAINTENANCE_STEPS_PER_ROUND,
	MAX_FAILURES,
	REQUESTS_PER_UNIT,
	STEWARD_KIND,
	STEWARD_RESOURCE,
	STEWARD_SCOPE,
	type StepId,
	type UnitKind,
	type UnitSlot,
} from "../contracts";
import {
	type UnitTargets,
	conversationsWithWork,
	failedMaintenanceUnits,
	insertUnit,
	openUnitOf,
	pendingInbox,
	readState,
	setUnitJob,
	writeState,
} from "../repository";
import { MAINTENANCE_ORDER, exchangeStepOf, steps } from "./steps";
import { eligible } from "./steps/maintenance-steps";
import type { StepEnv, StewardDeps } from "./types";
import type { Wake } from "./wake";

const log = getLogger("steward");

/** The long-term writers (curate, consolidate) are serialized across conversations. */
export const LONG_TERM_KEY = "steward:long-term";

type UnitSpec = {
	step: StepId;
	kind: UnitKind;
	targets: UnitTargets;
	/** Failed earlier attempts over the same target. */
	attempt: number;
};

/**
 * Making units: the unit row and its queue job are written together, so a unit never exists without its job.
 * A job is always available at once: a wait (a failed target, a deferred upkeep) is the wake timer's, because a
 * job enqueued for later would hold its `concurrencyKey` for every unit behind it.
 * `kickInTransaction` looks at what a conversation still needs and makes the next unit; it never throws.
 */
export function createKick(deps: StewardDeps, wake: Wake) {
	function createUnit(db: Database, conversationId: string, spec: UnitSpec) {
		const step = steps[spec.step];
		// A failed try of this kind waits; the timer kicks again when it is over.
		if (wake.paused(conversationId, step.slot)) return false;
		const id = deps.newId();
		const availableAtMs = deps.nowMs();
		db.exec("SAVEPOINT steward_unit");
		try {
			insertUnit(db, {
				id,
				conversationId,
				kind: spec.kind,
				step: spec.step,
				slot: step.slot,
				targets: spec.targets,
				attempt: spec.attempt,
				createdAt: deps.clock(),
			});
			const { job } = deps.queue.enqueueInTransaction(db, {
				scope: STEWARD_SCOPE,
				kind: STEWARD_KIND,
				// A unit is one try; a new try is a new unit with a new id (the queue keeps finished jobs by this key).
				dedupeKey: id,
				payload: { unitId: id },
				subjectRef: conversationId,
				lane: "background",
				resourceKey: STEWARD_RESOURCE,
				concurrencyKey: step.longTerm
					? LONG_TERM_KEY
					: `steward:${conversationId}`,
				maxAttempts: 3,
				availableAtMs,
				deadlineAtMs: availableAtMs + JOB_DEADLINE_MS,
			});
			setUnitJob(db, id, job.id);
			db.exec("RELEASE steward_unit");
			return true;
		} catch (error) {
			db.exec("ROLLBACK TO steward_unit");
			db.exec("RELEASE steward_unit");
			log.warn(
				"steward.unit_not_created",
				{ stepId: spec.step, reason: "enqueue_failed" },
				error,
			);
			return false;
		}
	}

	/** The next reflecting unit, if a request or an exchange still waits for a step. True: reflecting work exists. */
	function kickReflect(env: StepEnv): boolean {
		const { db, deps: d, conversationId } = env;
		const requests = pendingInbox(db, conversationId, REQUESTS_PER_UNIT);
		const curate = d.memory.pendingExchangesInTransaction(
			db,
			conversationId,
			"curated",
			EXCHANGES_PER_UNIT,
		);
		if (curate.length > 0 || requests.length > 0) {
			const attempt = Math.max(
				0,
				...curate.map((row) => row.failures.curated ?? 0),
				...requests.map((row) => row.failures),
			);
			createUnit(db, conversationId, {
				step: "curate-memory",
				kind: curate.length > 0 ? "exchange_step" : "requests",
				targets: {
					exchanges: curate.map((row) => row.inputMessageId),
					requests: requests.map((row) => row.id),
				},
				attempt,
			});
			return true;
		}
		for (const step of ["dispose-exchanges", "summarize"] as const) {
			const key = exchangeStepOf[step]!;
			const rows = d.memory.pendingExchangesInTransaction(
				db,
				conversationId,
				key,
				EXCHANGES_PER_UNIT,
			);
			if (rows.length === 0) continue;
			createUnit(db, conversationId, {
				step,
				kind: "exchange_step",
				targets: { exchanges: rows.map((row) => row.inputMessageId) },
				attempt: Math.max(0, ...rows.map((row) => row.failures[key] ?? 0)),
			});
			return true;
		}
		return false;
	}

	function kickRecall(env: StepEnv) {
		const { db, conversationId } = env;
		const state = readState(db, conversationId);
		if (!state.recallPending || openUnitOf(db, conversationId, "recall"))
			return;
		createUnit(db, conversationId, {
			step: "prepare-recall",
			kind: "exchange_step",
			targets: { message: state.recallPending },
			attempt: 0,
		});
	}

	/** Items remembered that the long-term layer does not carry yet (the Window counts them). */
	function pendingAdditions(env: StepEnv): number {
		const window = env.deps.memory.windows.storedInTransaction(
			env.db,
			env.conversationId,
		);
		return window?.shortTerm.pendingAdditions ?? 0;
	}

	/** Upkeep: a pending-limit consolidation at once; otherwise rounds of at most three steps per revision. */
	function kickMaintenance(env: StepEnv, reflecting: boolean) {
		const { db, deps: d, conversationId } = env;
		if (openUnitOf(db, conversationId, "maintenance")) return;
		const state = readState(db, conversationId);
		const revision = state.maintenanceRevision;
		const now = d.nowMs();
		const count = pendingAdditions(env);
		if (count < PENDING_LIMIT) {
			// The additions were taken into the long-term layer: the next time they pile up counts afresh.
			if (state.quiet.pending !== undefined) {
				const { pending: _drop, ...rest } = state.quiet;
				writeState(db, { ...state, quiet: rest });
			}
		} else if (
			count > (state.quiet.pending ?? 0) &&
			eligible(env, "consolidate-memory")
		) {
			const made = createUnit(db, conversationId, {
				step: "consolidate-memory",
				kind: "maintenance",
				targets: { revision, urgent: true },
				attempt: failedMaintenanceUnits(
					db,
					conversationId,
					"consolidate-memory",
					revision,
				),
			});
			// Once for each addition: a consolidation that decides to change nothing is not asked again until more come.
			if (made)
				writeState(db, { ...state, quiet: { ...state.quiet, pending: count } });
			return;
		}
		if (reflecting || revision <= state.maintainedRevision) return;
		const quiet = state.quiet.quiet ?? {};
		const round =
			state.quiet.round?.revision === revision
				? state.quiet.round
				: { revision, count: 0 };
		let chosen: StepId | null = null;
		if (round.count < MAINTENANCE_STEPS_PER_ROUND)
			for (const step of MAINTENANCE_ORDER) {
				if (quiet[step] === revision) continue;
				if (
					failedMaintenanceUnits(db, conversationId, step, revision) >=
					MAX_FAILURES
				)
					continue;
				if (!eligible(env, step)) continue;
				chosen = step;
				break;
			}
		if (chosen !== null && state.nextMaintenanceAt !== null) {
			// Upkeep deferred for a foreground run: nothing is enqueued before the time; the timer kicks again.
			if (state.nextMaintenanceAt > now) {
				wake.at(state.nextMaintenanceAt);
				return;
			}
		}
		if (chosen === null) {
			// The round is over: nothing is left to look at until a reflecting step changes something.
			writeState(db, {
				...state,
				maintainedRevision: revision,
				deferCount: 0,
				nextMaintenanceAt: null,
				quiet: { ...state.quiet, round },
			});
			return;
		}
		const made = createUnit(db, conversationId, {
			step: chosen,
			kind: "maintenance",
			targets: { revision },
			attempt: failedMaintenanceUnits(db, conversationId, chosen, revision),
		});
		if (made)
			writeState(db, {
				...state,
				quiet: { ...state.quiet, round: { revision, count: round.count + 1 } },
			});
	}

	function kickOne(db: Database, conversationId: string) {
		try {
			if (!deps.memory.readyInTransaction(db)) return;
			const env: StepEnv = { db, deps, conversationId };
			const reflecting = openUnitOf(db, conversationId, "reflect")
				? true
				: kickReflect(env);
			kickRecall(env);
			kickMaintenance(env, reflecting);
		} catch (error) {
			log.warn("steward.kick_failed", { reason: "kick_failed" }, error);
		}
	}

	/**
	 * Makes the units a conversation needs (every conversation with work when none is named, at startup: the ones
	 * the steward knows and the ones with exchanges still waiting for a step). Called
	 * inside the transaction of a settle or a run's end; whatever fails inside leaves that transaction alone.
	 */
	function kickInTransaction(db: Database, conversationId?: string) {
		if (conversationId !== undefined) return kickOne(db, conversationId);
		const ids = new Set([
			...conversationsWithWork(db),
			...deps.memory.pendingConversationIdsInTransaction(db),
		]);
		for (const id of ids) kickOne(db, id);
	}
	wake.onWake(() => deps.store.write((db) => kickInTransaction(db)));
	return { kickInTransaction, kickOne, createUnit };
}
export type Kick = ReturnType<typeof createKick>;
export type { UnitSlot };
