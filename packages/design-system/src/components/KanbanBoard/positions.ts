import type { KanbanBoardCard, KanbanBoardColumn } from "./types";

export type MovableColumn = "todo" | "finished";

export const COLUMNS: ReadonlyArray<{
	id: KanbanBoardColumn;
	label: string;
	empty: string;
	description: string;
}> = [
	{
		id: "todo",
		label: "未着手＋Planning",
		empty: "タスクはありません",
		description: "計画・編集用。実行するまでキューに入りません",
	},
	{
		id: "running",
		label: "Ongoing",
		empty: "実行待ち・実行中のタスクはありません",
		description: "キュー待ち・実行中",
	},
	{
		id: "finished",
		label: "Done・Blocker",
		description: "完了した作業・対応が必要な作業",
		empty: "終わったタスクはありません",
	},
];

export const MOVE_TARGETS: ReadonlyArray<{ id: MovableColumn; label: string }> =
	[
		{ id: "todo", label: "未着手＋Planning" },
		{ id: "finished", label: "Done・Blocker" },
	];

/** Cards of a column in board order, leaving out the card being moved. */
export function othersIn(
	cards: readonly KanbanBoardCard[],
	column: KanbanBoardColumn,
	movingId: string,
): KanbanBoardCard[] {
	return cards.filter((c) => c.column === column && c.id !== movingId);
}

/** The card after `cardId` in its own column, or null at the end. */
export function nextSiblingId(
	cards: readonly KanbanBoardCard[],
	cardId: string,
): string | null {
	const card = cards.find((c) => c.id === cardId);
	if (!card) return null;
	const column = cards.filter((c) => c.column === card.column);
	return column[column.findIndex((c) => c.id === cardId) + 1]?.id ?? null;
}

/** True when placing the card before `beforeId` in `column` leaves the board unchanged. */
export function isNoopMove(
	cards: readonly KanbanBoardCard[],
	cardId: string,
	column: KanbanBoardColumn,
	beforeId: string | null,
): boolean {
	const card = cards.find((c) => c.id === cardId);
	if (!card || card.column !== column) return false;
	return nextSiblingId(cards, cardId) === beforeId;
}

/**
 * The card a pointer at `y` would be dropped before: the first card (other than the dragged one)
 * whose vertical midpoint lies below the pointer; null when the pointer is below all of them.
 */
export function dropBeforeId(
	rects: ReadonlyArray<{ id: string; top: number; height: number }>,
	y: number,
): string | null {
	return rects.find((r) => y < r.top + r.height / 2)?.id ?? null;
}
