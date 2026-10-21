import type { Database } from "bun:sqlite";
import type { KanbanService } from "../../domains/kanban";
import type { DomainAdapter } from "../../domains/tool-runtime";

/** A saved board operation and the exact external run it created have separate completion states. */
export function kanbanExecution(
	kanban: KanbanService,
	ports: {
		cancel(db: Database, runId: string, cardId: string): boolean;
		stop(operationId: string): Promise<boolean>;
	},
): NonNullable<DomainAdapter["execution"]> {
	return {
		currentInTransaction(db, operationId) {
			const current = kanban.executionInTransaction(db, operationId),
				run = current.run;
			const state = !run
				? "completed"
				: run.state === "completed"
					? "completed"
					: run.state === "cancelled"
						? "cancelled"
						: run.state === "unknown"
							? "indeterminate"
							: run.state === "blocked"
								? "failed"
								: "running";
			return {
				state,
				ref: { operationId, runId: run?.id },
				summary: JSON.stringify(current).slice(0, 2000),
				output: current,
				modelCalls: 0,
				references: [],
			};
		},
		cancelInTransaction: (db, id) =>
			kanban.stopExecutionInTransaction(db, id, ports.cancel),
		stop: ports.stop,
		validateAnswerInTransaction: () => false,
	};
}
