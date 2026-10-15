import type { Database } from "bun:sqlite";
import { boardInTransaction } from "./board";
import type { KanbanBoardView, KanbanViewContext } from "./contracts";
import { allCards, defaultExecutor } from "./repository";
import {
	boardRuns,
	getQueue,
	handedRuns,
	waitingCount,
} from "./runs-repository";
import type { CommonRunState, ExecutorRegistry } from "./shared-contracts";
import { readWorkspaceGuard } from "./workspace-guard";

export type SharedBoardView = Omit<KanbanBoardView, "runs" | "cards"> & {
	defaultExecutorId: string;
	executors: ReturnType<ExecutorRegistry>;
	queues: Array<{
		executorId: string;
		state: "running" | "paused";
		reason?: string;
		waiting: number;
		activeRunId?: string;
	}>;
	cards: Array<
		KanbanBoardView["cards"][number] & {
			executorId: string;
			sessionRef?: string;
			workspaceBusy?: { executorId: string; state: string };
			canSelectExecutor: boolean;
		}
	>;
	runs: Array<
		Omit<KanbanBoardView["runs"][number], "state"> & {
			state: CommonRunState;
			executorId: string;
			executorRevision: number;
			workspaceRef: string;
			sessionRef?: string;
			attemptRef?: string;
			executionStopped: boolean;
		}
	>;
};

/** Version 2 projection. Version 1 keeps its legacy state vocabulary and receipt schema. */
export function sharedBoardInTransaction(
	tx: Database,
	view: KanbanViewContext,
	registry: ExecutorRegistry,
): SharedBoardView {
	const legacy = boardInTransaction(tx, view, { allExecutors: true });
	const executors = registry();
	const cards = new Map(allCards(tx).map((card) => [card.id, card]));
	const runs = new Map(boardRuns(tx).map((run) => [run.id, run]));
	return {
		...legacy,
		defaultExecutorId: defaultExecutor(tx),
		executors,
		queues: executors.map((executor) => {
			const active = handedRuns(tx, executor.id)[0];
			return {
				executorId: executor.id,
				...getQueue(tx, executor.id),
				waiting: waitingCount(tx, executor.id),
				...(active ? { activeRunId: active.id } : {}),
			};
		}),
		cards: legacy.cards.map((shown) => {
			const card = cards.get(shown.id)!;
			const executor = executors.find((entry) => entry.id === card.executorId);
			const run = card.currentRunId ? runs.get(card.currentRunId) : undefined;
			const guard =
				run?.state === "queued"
					? readWorkspaceGuard(tx, run.workspaceRef)
					: null;
			return {
				...shown,
				executorId: card.executorId,
				canSelectExecutor: card.column === "todo" && !card.hasExecutionHistory,
				...(guard &&
				(guard.ownerRef !== `kanban:${card.id}` || guard.state !== "held")
					? {
							workspaceBusy: {
								executorId: guard.executorId,
								state: guard.state,
							},
						}
					: {}),
				...(card.sessionRef ? { sessionRef: card.sessionRef } : {}),
				actions: shown.actions.filter((action) =>
					action === "open"
						? executor?.capabilities.terminal
						: action === "commitPush"
							? executor?.capabilities.commitPush
							: ["run", "followup"].includes(action)
								? executor?.available
								: true,
				),
			};
		}),
		runs: legacy.runs.map((shown) => {
			const run = runs.get(shown.id)!;
			return {
				...shown,
				state: run.state,
				executorId: run.executorId,
				executorRevision: run.executorRevision,
				workspaceRef: run.workspaceRef,
				executionStopped: run.executionStopped,
				...(run.sessionRef ? { sessionRef: run.sessionRef } : {}),
				...(run.attemptRef ? { attemptRef: run.attemptRef } : {}),
			};
		}),
	};
}
