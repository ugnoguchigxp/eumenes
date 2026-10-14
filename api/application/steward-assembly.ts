import type { Database } from "bun:sqlite";
import type { DialogueService } from "../domains/dialogue";
import {
	createStewardService,
	type RunLookup,
	type StewardDeps,
	type StewardService,
} from "../domains/steward";

type AssemblyDeps = Omit<
	StewardDeps,
	"foregroundActive" | "runStateOf" | "clock" | "nowMs" | "newId"
> & {
	queue: StewardDeps["queue"] & {
		registerHandler(handler: StewardService["handler"]): void;
	};
};

/**
 * The steward with its handler registered. It reads run states through dialogue, which the
 * server assembles later (`attachDialogue`); until then no run is known as active.
 */
export function createStewardAssembly(deps: AssemblyDeps) {
	let dialogue: Pick<DialogueService, "get" | "list"> | undefined;
	const steward = createStewardService({
		...deps,
		foregroundActive: (conversationId) =>
			!!dialogue
				?.list(conversationId)
				.some((run) => run.status === "queued" || run.status === "running"),
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
		attachDialogue(next: Pick<DialogueService, "get" | "list">) {
			dialogue = next;
		},
	};
}

/** Startup, after dialogue recovery (interrupted runs have ended) and before the queue starts. */
export function recoverSteward(steward: StewardService, db: Database) {
	steward.sweepStagedInTransaction(db);
	steward.kickInTransaction(db);
}
