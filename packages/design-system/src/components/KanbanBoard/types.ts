/*
 * Fixed props contract of KanbanBoard (spec/kanban-claude-code-plan-2026-10-14.md §3.10).
 * The component owns layout, forms, keyboard moves, dialogs and wording of its own controls; the
 * host owns data, status wording and every business decision (which actions a card allows).
 */

export type KanbanBoardColumn = "todo" | "running" | "finished";

/** Actions a card may offer; the host lists only the allowed ones for each card. */
export type KanbanCardAction =
	| "edit"
	| "remove"
	| "run"
	| "followup"
	| "commitPush"
	| "review"
	| "cancel"
	| "stop"
	| "reset"
	| "open";

export type KanbanBoardCard = {
	id: string;
	revision: number;
	title: string;
	prompt: string;
	column: KanbanBoardColumn;
	/** Shown on cards in `finished`. */
	label?: "done" | "blocker";
	/** Host wording of the state, e.g. 「キュー待ち（2番目）」「作業中」「許可を待っています」. */
	statusText?: string;
	/** Host wording of a blocker's reason. */
	reasonText?: string;
	reviewed: boolean;
	commitPushReported: boolean;
	/** Shows 「このタスクの後に別のタスクが実行されています」. */
	followedByOtherRun: boolean;
	lastReport?: string;
	files: string[];
	/** ISO timestamp. */
	updatedAt: string;
	actions: KanbanCardAction[];
};

export type KanbanBoardQueue = {
	state: "running" | "paused";
	/** Host wording of why the queue is paused. */
	reasonText?: string;
	waiting: number;
	/** Title of the card whose run is in progress. */
	runningTitle?: string;
};

export type KanbanBoardProps = {
	title?: string;
	cards: KanbanBoardCard[];
	queue: KanbanBoardQueue;
	/** False: run actions are disabled and `notRunnableText` is shown. */
	runnable: boolean;
	notRunnableText?: string;
	/** A write is in flight; controls are disabled. */
	busy?: boolean;
	/** Host wording for a rejected action or a conflict. */
	message?: string;
	onAdd: (input: { title: string; prompt: string }) => void;
	onEdit: (
		cardId: string,
		revision: number,
		change: { title?: string; prompt?: string },
	) => void;
	/** `beforeCardId: null` places the card at the end of the column. */
	onMove: (
		cardId: string,
		revision: number,
		column: "todo" | "finished",
		beforeCardId: string | null,
	) => void;
	/**
	 * Card actions other than edit/move. `followup` carries the note. `commitPush` is called only
	 * after the component's confirmation dialog (files, last report) was accepted.
	 */
	onAction: (
		action: Exclude<KanbanCardAction, "edit">,
		cardId: string,
		revision: number,
		extra?: { note?: string },
	) => void;
	onResumeQueue: () => void;
	className?: string;
};
