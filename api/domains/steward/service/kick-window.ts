/* The window side of the steward's kick: what the idle re-construction and the episode preparation read. */
import { episodeTokens } from "../../continuity";
import { MAX_FAILURES, SILENCE_BREAK_MS, SILENCE_WAIT_MS } from "../contracts";
import { failedEpisodeUnits, readState } from "../repository";
import { type EpisodeCandidate, rangeKey } from "./episode-plan";
import type { StepEnv } from "./types";
import type { Wake } from "./wake";

/** Items remembered that the published profile does not show yet (the window's `newMemories`). */
export function pendingAdditions(env: StepEnv): number {
	const window = env.deps.memory.windows.storedInTransaction(
		env.db,
		env.conversationId,
	);
	return window?.newMemories.length ?? 0;
}

/** Whether this candidate was given up (failed three times, or nothing to prepare). */
export function givenUp(env: StepEnv, candidate: EpisodeCandidate): boolean {
	const { db, conversationId } = env;
	const key = rangeKey(candidate.step, candidate.range);
	if (readState(db, conversationId).quiet.episode?.includes(key)) return true;
	return (
		failedEpisodeUnits(db, conversationId, candidate.step, candidate.range) >=
		MAX_FAILURES
	);
}

/**
 * The idle re-construction (section 12.3): when the log or the episode is over its limit,
 * no answer is being generated and the last event is at least `SILENCE_WAIT_MS` old, the window is rebuilt with
 * what was prepared; it never waits for a model. `waiting`: the preparation is still being made.
 */
export function reconstructIfDue(env: StepEnv, waiting: boolean, wake: Wake) {
	const { db, deps: d, conversationId } = env;
	const events = d.continuity.events;
	const plan = d.memory.windowPlan();
	const log = events.logInTransaction(db, conversationId);
	const logTokens = log.reduce((sum, event) => sum + event.tokens, 0);
	const logOver =
		log.length > 1 && (logTokens > plan.log.high || logTokens > plan.log.cap);
	const episodeOver =
		episodeTokens(events.episodeInTransaction(db, conversationId, "shown")) >
		plan.sections.episode;
	if (!logOver && !episodeOver) return;
	if (waiting) return;
	const now = d.nowMs();
	if (
		d.foregroundActive(db, conversationId) ||
		events.pendingInTransaction(db, conversationId).length > 0
	) {
		wake.at(now + SILENCE_WAIT_MS);
		return;
	}
	const last = Math.max(0, ...log.map((event) => Date.parse(event.at)));
	if (now < last + SILENCE_WAIT_MS) {
		wake.at(last + SILENCE_WAIT_MS);
		return;
	}
	events.reconstructInTransaction(db, {
		conversationId,
		at: d.clock(),
		reason: logOver ? "log_over_target" : "section_over_limit",
		limits: {
			log: plan.log,
			episode: plan.sections.episode,
			silenceMs: SILENCE_BREAK_MS,
		},
	});
	// The re-construction also takes the waiting additions into the profile (as the dialogue side does).
	const window = d.memory.windows.storedInTransaction(db, conversationId);
	if (window?.republishRequested || window?.newMemories.length)
		d.memory.republishWindowInTransaction(db, conversationId);
}
