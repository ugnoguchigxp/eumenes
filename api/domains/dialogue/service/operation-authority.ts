import type { Database } from "bun:sqlite";
import type { InferencePort, Receipt } from "../../inference";
import type { MemoryService } from "../../memory";
import { validateMemoryWindow, type PreparedMemory } from "./memory-window";

/** Control may start an operation only while every input authority is current. */
export function operationRejection(
	db: Database,
	input: {
		inference: InferencePort;
		receipt?: Receipt;
		memory?: MemoryService;
		memoryWindow?: PreparedMemory;
		settle: { runId: string };
	},
): string | null {
	if (
		input.receipt &&
		!input.inference.validateReceiptInTransaction?.(db, input.receipt)
	)
		return "permission_revoked";
	if (input.memoryWindow && input.memory) {
		const verdict = validateMemoryWindow(
			input.memory,
			db,
			input.settle.runId,
			input.memoryWindow,
		);
		if (!verdict.ok) return verdict.reason;
	}
	return null;
}
