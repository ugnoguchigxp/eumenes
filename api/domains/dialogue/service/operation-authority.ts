import type { Database } from "bun:sqlite";
import type { InferencePort, Receipt } from "../../inference";
import type { MemoryService, PreparedWindow } from "../../memory";
import { shownMessageForgotten } from "./memory-window";
import type {
	GoalsLayerPort,
	WorldContextPort,
	WorldContextSettleInput,
} from "../contracts";
import { goalsLayerStale, type PreparedGoals } from "./goals-layer";

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
		/** Messages recalled exchanges stand on; a quiet window is checked only when there are some. */
		recallPins?: ReadonlyArray<{ messageId: string; digest: string }>;
		/** The goals layer the deciding prompt carried; a forgotten goal it listed makes the decision stale. */
		goals?: GoalsLayerPort;
		goalsLayer?: PreparedGoals;
		world?: WorldContextPort;
		worldView?: { context: unknown };
		settle: WorldContextSettleInput;
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
	if (goalsLayerStale(input.goals, db, input.goalsLayer)) return "memory_stale";
	if (
		input.memoryWindow &&
		input.memory &&
		(!input.memoryWindow.quiet || (input.recallPins?.length ?? 0) > 0)
	) {
		const verdict = input.memory.validateWindowInTransaction(
			db,
			input.settle.runId,
			input.memoryWindow.window,
			input.recallPins,
		);
		if (!verdict.ok) return verdict.reason;
	}
	if (input.worldView && input.world) {
		const verdict = input.world.validateInTransaction(
			db,
			input.settle,
			input.worldView.context,
		);
		if (!verdict.ok) return verdict.reason;
	}
	return null;
}
