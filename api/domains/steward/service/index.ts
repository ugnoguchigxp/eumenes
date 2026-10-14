import { createInbox } from "./inbox";
import { createKick } from "./kick";
import { listDecisions } from "../repository";
import { createUnitHandler } from "./units";
import { createWake } from "./wake";
import type { StewardDeps } from "./types";

export type { StewardDeps, StewardMemory } from "./types";
export type { StageInput } from "./inbox";

/**
 * The steward: a background agent that keeps the conversation agent's ContextWindow as memory. Its steps run as
 * queue jobs; this object is what the application wires (the handler, the run-end and startup operations).
 */
export function createStewardService(deps: StewardDeps) {
	const wake = createWake(deps);
	const kick = createKick(deps, wake);
	const inbox = createInbox(deps, kick);
	const { handler } = createUnitHandler(deps, kick, wake);
	deps.memory.registerForgetPurge((db, purged) => inbox.purge(db, purged));
	return {
		/** The queue handler of `steward.step.v1`. */
		handler,
		/** Makes the units a conversation needs; without an id, for every conversation with work (startup). */
		kickInTransaction: kick.kickInTransaction,
		/** The `memory_request` tool: a request waits as `staged` until its run ends. */
		stageRequestInTransaction: inbox.stageRequestInTransaction,
		/** The state of a staged request by its id (the tool reads its receipt back with it). */
		requestInTransaction: inbox.requestInTransaction,
		/** A run ended: its requests are confirmed or discarded (section 2.5) and the steward is kicked. */
		runEndedInTransaction: inbox.runEndedInTransaction,
		/** Startup: sorts the staged requests of runs that no longer exist. Call before `kickInTransaction`. */
		sweepStagedInTransaction: inbox.sweepStagedInTransaction,
		/** Newest first. */
		decisions(conversationId: string, limit = 50) {
			return deps.store.read((db) => listDecisions(db, conversationId, limit));
		},
		/** The exchange ledger of a conversation. */
		exchanges(conversationId: string) {
			return deps.memory.exchanges(conversationId);
		},
	};
}
export type StewardService = ReturnType<typeof createStewardService>;
