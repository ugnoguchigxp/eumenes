import type { Database } from "bun:sqlite";
import type { InferencePort, Receipt } from "../../inference";
import type { MemoryService } from "../../memory";
import type { WorldContextPort, WorldContextSettleInput } from "../contracts";

/** Control may start an operation only while every input authority is current. */
export function operationRejection(
	db: Database,
	input: {
		inference: InferencePort;
		receipt?: Receipt;
		memory?: MemoryService;
		memoryView?: { view: unknown };
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
	if (input.memoryView && input.memory) {
		const verdict = input.memory.validateInTransaction(
			db,
			input.settle.conversationId,
			input.memoryView.view,
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
