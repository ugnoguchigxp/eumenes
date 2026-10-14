import type { KanbanBoardCard, KanbanBoardProps } from "./types";

/** Shared by the stories and the tests. */
export function card(
	id: string,
	over: Partial<KanbanBoardCard> = {},
): KanbanBoardCard {
	return {
		id,
		revision: 1,
		title: `タスク ${id}`,
		prompt: `${id} の依頼内容`,
		column: "todo",
		reviewed: false,
		commitPushReported: false,
		followedByOtherRun: false,
		files: [],
		updatedAt: "2026-10-14T01:30:00Z",
		actions: ["edit", "remove", "run"],
		...over,
	};
}

export const todoActions: KanbanBoardCard["actions"] = [
	"run",
	"edit",
	"remove",
];
export const doneActions: KanbanBoardCard["actions"] = [
	"review",
	"followup",
	"commitPush",
	"reset",
	"remove",
	"edit",
];
export const blockerActions: KanbanBoardCard["actions"] = [
	"run",
	"followup",
	"reset",
	"edit",
	"remove",
];

export const longReport = Array.from(
	{ length: 40 },
	(_, i) =>
		`${i + 1}. 手順 ${i + 1} を確認し、関連する設定とテストを更新しました。`,
).join("\n");

export const baseProps: KanbanBoardProps = {
	cards: [],
	queue: { state: "running", waiting: 0 },
	runnable: true,
	onAdd: () => {},
	onEdit: () => {},
	onMove: () => {},
	onAction: () => {},
	onResumeQueue: () => {},
};

export const cardA = card("a", {
	title: "README の手順修正",
	actions: todoActions,
});
export const cardB = card("b", {
	title: "ログ出力の見直し",
	actions: todoActions,
});
export const cardC = card("c", {
	title: "設定画面の文言統一",
	actions: todoActions,
});
export const todoCards = [cardA, cardB, cardC];
export const runningCard = card("r", {
	title: "API の型を整理",
	column: "running",
	statusText: "作業中",
	actions: ["stop", "open"],
});
export const doneCard = card("d", {
	title: "テストの追加",
	column: "finished",
	label: "done",
	lastReport: "テストを3件追加し、すべて通りました。",
	files: ["api/domains/kanban/test/kanban.test.ts", "docs/kanban.md"],
	actions: doneActions,
});
export const blockerCard = card("x", {
	title: "移行スクリプトの実行",
	column: "finished",
	label: "blocker",
	reasonText: "途中で止まりました（Esc などで中断されました）",
	actions: blockerActions,
});
