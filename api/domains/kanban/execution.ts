import type { Database } from "bun:sqlite";
import type { Core } from "./core";
import type { RunState, KanbanRunFinish, KanbanDispatch } from "./contracts";
import { bumpBoard, getCard, updateCard, rememberExecutor } from "./repository";
import { getRun, transitionRun } from "./runs-repository";
import { ACTIVE_RUN_STATES } from "./shared-contracts";

/** The adapter supplies structured execution facts. Message text never chooses a state. */
export type ExecutionObservation = {
	runId: string;
	executorId: string;
	executorRevision: number;
	attemptRef: string;
	state: Exclude<RunState, "queued">;
	sessionRef?: string;
	executionStopped: boolean;
};
const transitions: Record<string, readonly RunState[]> = {
	dispatched: [
		"dispatched",
		"running",
		"waiting",
		"settling",
		"stopping",
		"completed",
		"blocked",
		"cancelled",
		"unknown",
	],
	running: [
		"running",
		"waiting",
		"settling",
		"stopping",
		"completed",
		"blocked",
		"cancelled",
		"unknown",
	],
	waiting: [
		"waiting",
		"running",
		"stopping",
		"settling",
		"completed",
		"blocked",
		"cancelled",
		"unknown",
	],
	settling: [
		"settling",
		"stopping",
		"completed",
		"blocked",
		"cancelled",
		"unknown",
	],
	stopping: ["stopping", "blocked", "cancelled", "unknown"],
};
export function createExecutionOperations(core: Core) {
	function observeExecutionInTransaction(
		tx: Database,
		input: ExecutionObservation,
	): boolean {
		const run = getRun(tx, input.runId);
		if (
			!run ||
			run.executorId !== input.executorId ||
			run.executorRevision !== input.executorRevision ||
			(run.attemptRef && run.attemptRef !== input.attemptRef)
		)
			return false;
		if (!transitions[run.state]?.includes(input.state)) return false;
		if (
			["completed", "blocked", "cancelled"].includes(input.state) &&
			!input.executionStopped
		)
			throw new Error("kanban_execution_stop_unconfirmed");
		if (
			run.sessionRef &&
			input.sessionRef &&
			run.sessionRef !== input.sessionRef
		)
			throw new Error("kanban_session_mismatch");
		tx.query(
			"UPDATE kanban_runs SET attempt_ref=?,session_ref=COALESCE(?,session_ref),execution_stopped=? WHERE id=?",
		).run(
			input.attemptRef,
			input.sessionRef ?? null,
			input.executionStopped ? 1 : 0,
			run.id,
		);
		const card = getCard(tx, run.cardId);
		if (card?.currentRunId === run.id)
			updateCard(tx, {
				...card,
				sessionRef: input.sessionRef ?? card.sessionRef,
				hasExecutionHistory:
					card.hasExecutionHistory ||
					!["dispatched", "cancelled"].includes(input.state),
			});
		// Final adoption is done by settle in the same writer transaction as the executor result.
		if (ACTIVE_RUN_STATES.includes(input.state))
			transitionRun(tx, run.id, ACTIVE_RUN_STATES, { state: input.state });
		bumpBoard(tx);
		return true;
	}
	/** Busy workspace means queued, preserving FIFO; it is never a send failure. */
	function deferDispatchInTransaction(tx: Database, runId: string) {
		const run = getRun(tx, runId);
		if (!run || run.state !== "dispatched" || run.attemptRef)
			throw new Error("kanban_dispatch_already_started");
		tx.query(
			"UPDATE kanban_runs SET state='queued',handed_at=NULL WHERE id=? AND state='dispatched' AND attempt_ref IS NULL",
		).run(runId);
		bumpBoard(tx);
	}
	function selectExecutorInTransaction(
		tx: Database,
		input: { cardId: string; expectedRevision: number; executorId: string },
		requestId: string,
	) {
		return core.operate(tx, requestId, "select_executor", input, () => {
			const card = core.target(tx, input.cardId, input.expectedRevision);
			const executor = core.executor(input.executorId);
			if (rememberExecutor(tx, executor.id)) bumpBoard(tx);
			if (card.column !== "todo" || card.hasExecutionHistory)
				throw new Error("kanban_handoff_required");
			if (card.executorId === executor.id)
				return { receipt: core.receiptOf("edited", card) };
			const changed = {
				...card,
				executorId: executor.id,
				revision: card.revision + 1,
				updatedAt: core.now(),
			};
			updateCard(tx, changed);
			bumpBoard(tx);
			return { receipt: core.receiptOf("edited", changed) };
		});
	}
	return {
		observeExecutionInTransaction,
		deferDispatchInTransaction,
		selectExecutorInTransaction,
	};
}

export function createExecutionAdopter(
	core: Core,
	operations: {
		finishRunInTransaction: (
			tx: Database,
			finish: KanbanRunFinish,
		) => { dispatch?: KanbanDispatch } | null;
		pauseQueueInTransaction: (
			tx: Database,
			reason: "stop_unconfirmed",
			executorId: string,
		) => boolean;
	},
) {
	const { observeExecutionInTransaction } = createExecutionOperations(core);
	return {
		finishExecutionInTransaction(
			tx: Database,
			input: ExecutionObservation & {
				state: "completed" | "blocked" | "cancelled" | "unknown";
				git?: KanbanRunFinish["git"];
				reason?: string;
				report?: {
					summary: string;
					blocker?: string;
					files: readonly string[];
				};
			},
		) {
			if (!observeExecutionInTransaction(tx, input)) return null;
			if (input.state === "unknown")
				operations.pauseQueueInTransaction(
					tx,
					"stop_unconfirmed",
					input.executorId,
				);
			const final = operations.finishRunInTransaction(tx, {
				runId: input.runId,
				state: input.state === "blocked" ? "ended" : input.state,
				reason: input.reason,
				lastReport: input.report?.summary ?? "",
				files: input.report?.files ?? [],
				git: input.git,
			});
			if (input.state === "unknown")
				tx.query(
					"UPDATE kanban_runs SET state='unknown',execution_stopped=0 WHERE id=?",
				).run(input.runId);
			const run = getRun(tx, input.runId)!;
			const card = getCard(tx, run.cardId);
			if (
				card?.currentRunId === run.id &&
				input.report &&
				input.state !== "completed"
			)
				updateCard(tx, {
					...card,
					lastReport: [input.report.summary, input.report.blocker]
						.filter(Boolean)
						.join("\n\n"),
					files: [...new Set([...card.files, ...input.report.files])].slice(
						0,
						200,
					),
				});
			return final;
		},
	};
}
