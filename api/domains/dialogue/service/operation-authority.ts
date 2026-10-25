import type { Database } from "bun:sqlite";
import type { InferencePort, Receipt } from "../../inference";
import type { MemoryService, PreparedWindow } from "../../memory";
import { shownMessageForgotten } from "./memory-window";
import type { GoalsLayerPort } from "../contracts";
import { goalsStale, type PreparedGoals } from "./goals-state";

/** Control may start an operation only while every input authority is current. */
export function operationRejection(
	db: Database,
	input: {
		inference: InferencePort;
		receipt?: Receipt;
		memory?: MemoryService;
		memoryWindow?: {
			window: PreparedWindow;
			quiet?: true;
			blockedAtPrepare?: string[];
		};
		/** The goals layer the deciding prompt carried; a forgotten goal it listed makes the decision stale. */
		goals?: GoalsLayerPort;
		goalsLayer?: PreparedGoals;
		settle: { runId: string };
	},
): string | null {
	if (
		input.receipt &&
		!input.inference.validateReceiptInTransaction?.(db, input.receipt)
	)
		return "permission_revoked";
	if (
		input.memoryWindow &&
		input.memory &&
		shownMessageForgotten(input.memory, db, input.memoryWindow)
	)
		return "memory_stale";
	if (goalsStale(input.goals, db, input.goalsLayer)) return "memory_stale";
	if (input.memoryWindow && input.memory && !input.memoryWindow.quiet) {
		const verdict = input.memory.validateWindowInTransaction(
			db,
			input.settle.runId,
			input.memoryWindow.window,
		);
		if (!verdict.ok) return verdict.reason;
	}
	return null;
}
