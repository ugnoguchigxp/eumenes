import type { Database } from "bun:sqlite";
import type {
	BlockerReason,
	KanbanDispatch,
	KanbanRunFinish,
} from "./contracts";
import type { Core } from "./core";
import type { Queue } from "./queue";
import { bumpBoard, getCard, updateCard, type CardRow } from "./repository";
import { getRun, transitionRun, type RunRow } from "./runs-repository";
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
		transitionRun(tx, run.id, ["waiting_turn", "handed"], {
			state: runState,
			reason,
			finishedAt: now(),
		});
		const card = getCard(tx, run.cardId);
		if (card && card.currentRunId === run.id)
			finishCard(tx, card, { label: "blocker", reason });
		if (card && !quietReason(reason))
			notify(
				tx,
				"blocker",
				noticeText("blocker", run.title, BLOCKER_TEXT[reason]),
				card,
				run.id,
			);
		if (pausesQueue(reason))
			pauseQueue(tx, reason === "restarted" ? "restarted" : "tracking_lost");
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
		if (!run || run.state !== "handed") return null;
		if (finish.state === "completed") {
			transitionRun(tx, run.id, ["handed"], {
				state: "completed",
				finishedAt: now(),
			});
			const card = getCard(tx, run.cardId);
			if (card && card.currentRunId === run.id) {
				const report = finish.lastReport || card.lastReport;
				const changed =
					run.kind === "commit_push"
						? { commitPushReported: true }
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
					reason: null,
					lastReport: report,
					...changed,
				});
				const kind = run.kind === "commit_push" ? "commit_push" : "done";
				notify(tx, kind, noticeText(kind, run.title), card, run.id);
			}
		} else {
			blockRun(
				tx,
				run,
				blockerReason(finish),
				finish.state === "cancelled" ? "cancelled" : "blocked",
			);
		}
		bumpBoard(tx);
		return { dispatch: nextDispatch(tx) };
	}

	/**
	 * Handing the run to terminals failed in the transaction that was to do it (tracking became
	 * unavailable): the run is blocked and the queue stops.
	 */
	function dispatchFailedInTransaction(tx: Database, runId: string) {
		const run = getRun(tx, runId);
		if (run?.state === "handed") blockRun(tx, run, "send_failed", "blocked");
		pauseQueue(tx, "tracking_lost");
	}

	/** The run's request waits for the person's permission (once per run). */
	function waitingInTransaction(tx: Database, runId: string) {
		const run = getRun(tx, runId);
		if (run?.state !== "handed") return;
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
