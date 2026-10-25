import type { Database } from "bun:sqlite";
import type { DialogueService } from "../../domains/dialogue";
import {
	createStewardService,
	type RunLookup,
	type StewardDeps,
	type StewardService,
} from "../../domains/steward";

type AssemblyDeps = Omit<
	StewardDeps,
	| "foregroundActive"
	| "runStateOf"
	| "clock"
	| "nowMs"
	| "newId"
	| "conversationPrefix"
> & {
	queue: StewardDeps["queue"] & {
		registerHandler(handler: StewardService["handler"]): void;
	};
};

type StewardDialogue = Pick<
	DialogueService,
	| "get"
	| "conversationHasActiveRunInTransaction"
	| "conversationPrefixInTransaction"
>;

/**
 * The steward with its handler registered. It reads run states and the conversation's prompt prefix through
 * dialogue, which the server assembles later (`attachDialogue`); until then no run is known as active and the steps
 * keep their own prompts.
 */
export function createStewardAssembly(deps: AssemblyDeps) {
	let dialogue: StewardDialogue | undefined;
	const steward = createStewardService({
		...deps,
		foregroundActive: (db, conversationId) =>
			dialogue?.conversationHasActiveRunInTransaction(db, conversationId) ??
			false,
		conversationPrefix: () => dialogue?.conversationPrefixInTransaction,
		runStateOf: (runId): RunLookup => {
			const run = dialogue?.get(runId);
			if (!run) return "stale";
			return run.status === "queued" || run.status === "running"
				? "active"
				: run.status;
		},
		clock: () => new Date().toISOString(),
		nowMs: () => Date.now(),
		newId: () => crypto.randomUUID(),
	});
	deps.queue.registerHandler(steward.handler);
	return {
		steward,
		attachDialogue(next: StewardDialogue) {
			dialogue = next;
		},
	};
}

/** Startup, after dialogue recovery (interrupted runs have ended) and before the queue starts. */
export function recoverSteward(steward: StewardService, db: Database) {
	steward.kickInTransaction(db);
}
