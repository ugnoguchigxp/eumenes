import { createEventStore } from "./events";
import { createVisibility } from "./evidence";
import { createPlans } from "./plans";
import { createQuestions } from "./questions";
import type { EvidenceExclusion } from "../contracts/plans";
import { deleteBySources } from "../repository/plans";

/** The short-term layer: the event flow (what was said), plans with a date (L3) and the question ledger. */
export function createContinuityService(
	clock: () => string = () => new Date().toISOString(),
	id: () => string = () => crypto.randomUUID(),
) {
	let exclusion: EvidenceExclusion | undefined;
	const visible = createVisibility(() => exclusion);
	return {
		/**
		 * The memory domain's immediate exclusion: plans and ledger entries that rest on an excluded
		 * message or memory item are left out of every read until the closure delete removes them.
		 */
		setEvidenceExclusion(next: EvidenceExclusion) {
			exclusion = next;
		},
		/** Plans with a date (L3): add, update, close, overdue, list, search. */
		plans: createPlans(clock, id, visible),
		/** What was asked of the user and what became of it. */
		questions: createQuestions(clock, id, visible),
		/**
		 * Forgetting: deletes the plans and ledger entries that rest on any of the messages or memory
		 * items. Called by the forget's purge.
		 */
		deleteDerivedBySourcesInTransaction: deleteBySources,
		/** The event flow, episode, work results and window version (the active short-term memory). */
		events: createEventStore(),
	};
}
export type ContinuityService = ReturnType<typeof createContinuityService>;
