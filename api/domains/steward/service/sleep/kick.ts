import type { Database } from "bun:sqlite";
import { getLogger } from "../../../../infrastructure/logger";
import {
	FORGET_KEY,
	MAX_FAILURES,
	SLEEP_KEY,
	type SleepStepId,
} from "../../contracts";
import {
	type UnitTargets,
	conversationsWithWork,
	excludedInbox,
	excludedItemIds,
	failedSleepUnits,
	openUnitOf,
	readPositions,
	readSleepState,
	touchPosition,
} from "../../repository";
import { pendingEvents } from "../steps/shared";
import type { StepEnv, StewardDeps } from "../types";
import type { Wake } from "../wake";
import { excludedTargets, newCandidateCount } from "./library";
import { restOf } from "./rest";
import {
	SLEEP_POLICY,
	inSleepWindow,
	jstDay,
	type SleepWindow,
} from "./policy";

const log = getLogger("steward");

/** A step that failed `MAX_FAILURES` times in a row is not tried again before this (or a restart's fresh start). */
const GIVE_UP_FOR_MS = 6 * 3_600_000;
const DAY_MS = 86_400_000;
const JST_OFFSET_MS = 9 * 3_600_000;
/** Failures that only gave the connection to the conversation are not the step's fault. */
export const YIELD_CODES = ["larm_preempted"] as const;

export type SleepUnitSpec = {
	step: SleepStepId;
	targets: UnitTargets;
	attempt: number;
};

/** The next time the window opens (its start, in Asia/Tokyo), after `ms`. */
export function nextWindowStart(ms: number, window: SleepWindow): number {
	const [h, m] = window.start.split(":");
	const startMinute = Number(h) * 60 + Number(m);
	const dayStart =
		Math.floor((ms + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS;
	const today = dayStart + startMinute * 60_000;
	return today > ms ? today : today + DAY_MS;
}

/**
 * When the sleep layer starts (the memory redesign, section 6.1). Nothing here delays work by a fixed timer: the
 * layer waits for the conversation to rest (the user's own interval between utterances) and for the user's own
 * time window; both wake the steward at the time they end. `make` writes the unit and its queue job.
 */
export function createSleepKick(
	deps: StewardDeps,
	wake: Wake,
	make: (db: Database, spec: SleepUnitSpec) => boolean,
) {
	/** The steps that are given up now (the warning is for the change, not for each look). */
	const givenUp = new Set<SleepStepId>();

	/** The conversations the layer watches: the ones it has seen, and the ones with events or forgets waiting. */
	function watched(db: Database): string[] {
		return [
			...new Set([
				...Object.keys(readPositions(db)),
				...conversationsWithWork(db),
				...deps.continuity.events.conversationsWithUncuratedInTransaction(db),
			]),
		];
	}

	/** Events (of every conversation) since the last deep run, and where each conversation stands now. */
	function newEvents(db: Database, conversationIds: readonly string[]) {
		const known = readPositions(db);
		const positions: Record<string, number> = {};
		let total = 0;
		for (const id of conversationIds) {
			const latest = deps.continuity.events.latestSeqInTransaction(db, id);
			positions[id] = latest;
			total += Math.max(0, latest - (known[id] ?? 0));
		}
		return { total, positions };
	}

	/**
	 * The closure delete of the forgets that were excluded at once: it does not wait for a conversation run and has
	 * a unit slot of its own, so it never waits for a sleep unit either.
	 */
	function kickForget(db: Database, scanOrphans: boolean) {
		if (openUnitOf(db, FORGET_KEY, "maintenance")) return;
		const rows = excludedInbox(db, SLEEP_POLICY.forgetsPerUnit);
		// After a restore the library's journal puts the exclusions back, while the inbox may be as old as the backup:
		// what is excluded and named by no request is closed too.
		const orphans = scanOrphans ? orphanExclusions(db) : null;
		if (rows.length === 0 && !orphans) return;
		make(db, {
			step: "forget-closure",
			targets: {
				requests: rows.map((row) => row.id),
				urgent: true,
				...(orphans ? { orphans: orphans.itemIds } : {}),
			},
			attempt: Math.max(0, ...rows.map((row) => row.failures)),
		});
	}

	/** What the library holds excluded that no `excluded` request of the inbox names; null when there is none. */
	function orphanExclusions(db: Database) {
		const held = excludedTargets(db, deps);
		const named = new Set(excludedItemIds(db));
		const itemIds = held.itemIds.filter((id) => !named.has(id));
		return itemIds.length > 0 ? { itemIds } : null;
	}

	/** The failures of a step in a row: the attempt of the next unit, or null while the step is given up for a while. */
	function attemptOf(db: Database, step: SleepStepId): number | null {
		const failed = failedSleepUnits(db, SLEEP_KEY, step, YIELD_CODES);
		if (failed.count < MAX_FAILURES) {
			givenUp.delete(step);
			return failed.count;
		}
		const retryAt = Date.parse(failed.lastClosedAt ?? "") + GIVE_UP_FOR_MS;
		if (deps.nowMs() >= retryAt) {
			givenUp.delete(step);
			return 0;
		}
		wake.at(retryAt);
		// Said once, when the step is given up (not at every kick while it waits).
		if (!givenUp.has(step)) {
			givenUp.add(step);
			log.warn("steward.sleep_given_up", { stepId: step, reason: "failures" });
		}
		return null;
	}

	function kickSleep(db: Database) {
		const sleep = deps.sleep;
		if (!sleep || openUnitOf(db, SLEEP_KEY, "maintenance")) return;
		const now = deps.nowMs();
		const conversationIds = watched(db);
		const state = readSleepState(db);
		const window = sleep.window();
		const events = newEvents(db, conversationIds);
		const windowDeep =
			events.total >= SLEEP_POLICY.deepEvents && state.deepDay !== jstDay(now);
		const deep: "deep" | "supplement" | null =
			windowDeep && inSleepWindow(now, window)
				? "deep"
				: events.total >= SLEEP_POLICY.supplementEvents
					? "supplement"
					: null;
		// Only the user's own window ends the wait for the deep run: the timer is for its start.
		if (!deep && windowDeep) wake.at(nextWindowStart(now, window));
		const consolidate =
			newCandidateCount(
				db,
				deps,
				state.shallowWatermark,
				SLEEP_POLICY.shallowCandidates,
			) >= SLEEP_POLICY.shallowCandidates;
		// Turns of the handled events are embedded together with the shallow run (not at every exchange).
		const embed = conversationIds.some(
			(id) =>
				pendingEvents({ db, deps, conversationId: id } satisfies StepEnv)
					.length > 0,
		);
		if (!deep && !consolidate && !embed) return;
		const resting = restOf(db, deps, conversationIds);
		if (!resting.rested) {
			if (resting.restAt !== null) wake.at(resting.restAt);
			return;
		}
		const step: SleepStepId = deep ? "deep" : "shallow";
		const attempt = attemptOf(db, step);
		if (attempt === null) return;
		if (wake.paused(SLEEP_KEY, "maintenance")) return;
		make(db, {
			step,
			attempt,
			targets: deep
				? { supplement: deep === "supplement", positions: events.positions }
				: { embed, consolidate },
		});
	}

	return {
		/** The conversation is known to the deep run's event count from now on. */
		touch: (db: Database, conversationId: string) =>
			touchPosition(db, conversationId),
		kick(db: Database, options: { orphans?: boolean } = {}) {
			try {
				kickForget(db, options.orphans === true);
				if (deps.memory.readyInTransaction(db)) kickSleep(db);
			} catch (error) {
				log.warn("steward.sleep_kick_failed", { reason: "kick_failed" }, error);
			}
		},
	};
}
