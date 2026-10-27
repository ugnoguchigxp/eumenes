import { createActivity } from "./activity";
import { createInbox } from "./inbox";
import { createKick } from "./kick";
import { listDecisions } from "../repository";
import { createUnitHandler } from "./units";
import { createWake } from "./wake";
import type { StewardDeps } from "./types";

export type { StewardDeps } from "./types";
export { createWorldView } from "./world-view";

/**
 * The steward: a background agent that keeps the conversation agent's ContextWindow as memory. Its steps run as
 * queue jobs; this object is what the application wires (the handler, the run-end and startup operations).
 */
export function createStewardService(deps: StewardDeps) {
	const wake = createWake(deps);
	const kick = createKick(deps, wake);
	const inbox = createInbox(deps, kick);
	const { handler } = createUnitHandler(deps, kick, wake);
	const { activity, errorReport } = createActivity(deps);
	deps.memory.registerForgetPurge((db, purged) => inbox.purge(db, purged));
	return {
		/** The queue handler of `steward.step.v1`. */
		handler,
		/**
		 * Makes the units a conversation needs; without an id, for every conversation with work
		 * (startup).
		 */
		kickInTransaction: kick.kickInTransaction,
		/** The conversation agent's memory tool (dialogue calls it directly): the request waits as `pending` from the moment the action is committed. */
		requestInTransaction: inbox.requestInTransaction,
		/** A run ended: the steward looks again (its requests were queued when they were committed). */
		runEndedInTransaction: inbox.runEndedInTransaction,
		/** Newest first. */
		decisions(conversationId: string, limit = 50) {
			return deps.store.read((db) => listDecisions(db, conversationId, limit));
		},
		/** What runs now and what failed last in a conversation (the conversation screen's indicator). */
		activity,
		/** The diagnostic text of the conversation's steward failures; null when none is failing. */
		errorReport,
		/** The conversation's event log (the flow the steward reads from), in log order. */
		events(conversationId: string) {
			return deps.store.read((db) =>
				deps.continuity.events.logInTransaction(db, conversationId),
			);
		},
	};
}
export type StewardService = ReturnType<typeof createStewardService>;
