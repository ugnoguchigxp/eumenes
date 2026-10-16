import type { Database } from "bun:sqlite";
import { ACTIVE_RUN_STATES, OPEN_RUN_STATES } from "../contracts/shared";
import type {
	BlockerReason,
	KanbanDispatch,
	KanbanRunFinish,
} from "../contracts";
import type { Core } from "./core";
import type { Queue } from "./queue";
import { bumpBoard, getCard, updateCard, type CardRow } from "../repository";
import { getRun, transitionRun, type RunRow } from "../repository/runs";
import {
	BLOCKER_TEXT,
	blockerReason,
	noticeText,
	pausesQueue,
	quietReason,
} from "./text";

const mergeFiles = (a: readonly string[], b: readonly string[]): string[] =>
	[...new Set([...a, ...b])].slice(0, 200);

/**
 * How a run ends (plan §3.7): the card becomes Done or a Blocker, the notice is saved and the
 * queue moves on. Only the card's current run changes the card.
 */
export function createSettle(core: Core, queue: Queue) {
	const { now, appendToColumn } = core;
	const { notify, pauseQueue, nextDispatch } = queue;

	/** Moves a running card to `finished` with a label (and the run-dependent fields). */
	function finishCard(
		tx: Database,
		card: CardRow,
		change: Partial<CardRow> & Pick<CardRow, "label" | "reason">,
	): CardRow {
		const done: CardRow = {
			...card,
			...change,
			column: "finished",
			revision: card.revision + 1,
			updatedAt: now(),
		};
		updateCard(tx, done);
		appendToColumn(tx, done, card.column);
		bumpBoard(tx);
		return done;
	}

	/** A run that ended without completing: the card becomes a Blocker, the queue may stop. */
	function blockRun(
		tx: Database,
		run: RunRow,
		reason: BlockerReason,
		runState: "blocked" | "cancelled",
	) {
		transitionRun(tx, run.id, OPEN_RUN_STATES, {
			state: ["unknown", "tracking_lost", "restarted"].includes(reason)
				? "unknown"
				: runState,
			reason,
			finishedAt: now(),
		});
		const card = getCard(tx, run.cardId);
		if (card && card.currentRunId === run.id)
			finishCard(tx, card, {
				label: "blocker",
				reason,
				hasExecutionHistory:
					card.hasExecutionHistory ||
					!["cancelled", "send_failed"].includes(reason),
			});
		if (card && !quietReason(reason))
			notify(
				tx,
				"blocker",
				noticeText("blocker", run.title, BLOCKER_TEXT[reason]),
				card,
				run.id,
			);
		if (pausesQueue(reason))
			pauseQueue(
				tx,
				reason === "restarted" ? "restarted" : "tracking_lost",
				run.executorId,
			);
	}

	/**
	 * A terminals request reached a final state. Only the card's current run changes the card; the
	 * notice is saved with it; the queue moves on unless it was stopped. Returns what to hand over
	 * next, or null when this is not a handed-over run of this board.
	 */
	function finishRunInTransaction(
		tx: Database,
		finish: KanbanRunFinish,
	): { dispatch?: KanbanDispatch } | null {
		const run = getRun(tx, finish.runId);
		if (!run || !ACTIVE_RUN_STATES.includes(run.state)) return null;
		tx.query("UPDATE kanban_runs SET execution_stopped=? WHERE id=?").run(
			finish.state === "unknown" ? 0 : 1,
			run.id,
		);
		if (finish.state === "completed") {
			transitionRun(tx, run.id, ACTIVE_RUN_STATES, {
				state: "completed",
				finishedAt: now(),
			});
			const card = getCard(tx, run.cardId);
			if (card && card.currentRunId === run.id) {
				const report = finish.lastReport || card.lastReport;
				const changed = ["commit_push", "commit", "push"].includes(run.kind)
					? { commitPushReported: !finish.git && run.kind === "commit_push" }
					: {
							reviewed: false,
							commitPushReported: false,
							files:
								run.kind === "task"
									? [...finish.files]
									: mergeFiles(card.files, finish.files),
						};
				finishCard(tx, card, {
					label: "done",
					hasExecutionHistory: true,
					reason: null,
					lastReport: report,
					...changed,
				});
				const kind = finish.git
					? "git_completed"
					: run.kind === "commit_push"
						? "commit_push"
						: "done";
				notify(
					tx,
					kind,
					noticeText(
						kind,
						run.title,
						finish.git?.remoteSha ?? finish.git?.commitSha,
					),
					card,
					run.id,
				);
			}
		} else {
			blockRun(
				tx,
				run,
				blockerReason(finish),
				finish.state === "cancelled" ? "cancelled" : "blocked",
			);
			if (finish.git?.commitVerified && finish.git.commitSha)
				tx.query(
					"UPDATE kanban_notices SET text=text||? WHERE run_id=? AND kind='blocker'",
				).run(
					`（commit確認済み: ${finish.git.commitSha}、push未確認）`,
					run.id,
				);
		}
		bumpBoard(tx);
		return { dispatch: nextDispatch(tx, run.executorId) };
	}

	/**
	 * Handing the run to terminals failed in the transaction that was to do it (tracking became
	 * unavailable): the run is blocked and the queue stops.
	 */
	function dispatchFailedInTransaction(tx: Database, runId: string) {
		const run = getRun(tx, runId);
		if (run && ACTIVE_RUN_STATES.includes(run.state))
			blockRun(tx, run, "send_failed", "blocked");
		if (run) pauseQueue(tx, "tracking_lost", run.executorId);
	}

	/** The run's request waits for the person's permission (once per run). */
	function waitingInTransaction(tx: Database, runId: string) {
		const run = getRun(tx, runId);
		if (!run || !ACTIVE_RUN_STATES.includes(run.state)) return;
		const card = getCard(tx, run.cardId);
		if (card)
			notify(tx, "waiting", noticeText("waiting", run.title), card, run.id);
	}

	return {
		blockRun,
		finishRunInTransaction,
		dispatchFailedInTransaction,
		waitingInTransaction,
	};
}
