import type { Database } from "bun:sqlite";
import type { InferencePort, Receipt } from "../../inference";
import type { MemoryService, PreparedWindow } from "../../memory";
import type { WorldContextPort, WorldContextSettleInput } from "../contracts";

/** Control may start an operation only while every input authority is current. */
export function operationRejection(
	db: Database,
	input: {
		inference: InferencePort;
		receipt?: Receipt;
		memory?: MemoryService;
		memoryWindow?: { window: PreparedWindow; quiet?: true };
		/** Messages recalled exchanges stand on; a quiet window is checked only when there are some. */
		recallPins?: ReadonlyArray<{ messageId: string; digest: string }>;
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
