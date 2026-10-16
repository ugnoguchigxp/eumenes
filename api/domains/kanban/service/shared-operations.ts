import type { Database } from "bun:sqlite";
import type {
	KanbanAddInput,
	KanbanCardRefInput,
	KanbanOperationContext,
} from "../contracts";
import type { Core, KanbanOutcome } from "./core";

export function createSharedOperations(
	core: Core,
	operations: {
		addInTransaction: (
			tx: Database,
			input: KanbanAddInput & { executorId?: string },
			requestId: string,
		) => KanbanOutcome;
		runInTransaction: (
			tx: Database,
			input: KanbanCardRefInput,
			requestId: string,
			context: KanbanOperationContext,
		) => KanbanOutcome;
	},
) {
	return {
		addAndRunInTransaction(
			tx: Database,
			input: KanbanAddInput & { executorId: string },
			requestId: string,
			context: KanbanOperationContext,
		): KanbanOutcome {
			return core.operate(tx, requestId, "add_and_run", input, () => {
				const created = operations.addInTransaction(
					tx,
					input,
					`${requestId}/add`,
				);
				const run = operations.runInTransaction(
					tx,
					{
						cardId: created.receipt.cardId,
						expectedRevision: created.receipt.revision,
					},
					`${requestId}/run`,
					context,
				);
				return { receipt: run.receipt, dispatch: run.dispatch };
			});
		},
	};
}
