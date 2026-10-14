import type { KanbanBoardSource } from "@eumenes/artifact-ui";

const card = (
	id: string,
	over: Partial<KanbanBoardSource["cards"][number]> = {},
): KanbanBoardSource["cards"][number] => ({
	id,
	revision: 2,
	title: `タスク ${id}`,
	prompt: `${id} の依頼内容`,
	column: "todo",
	reviewed: false,
	commitPushReported: false,
	followedByOtherRun: false,
	files: [],
	updatedAt: "2026-10-14T01:30:00Z",
	actions: ["run", "edit", "remove", "open"],
	...over,
});

/** One card per column and state the view words: queued, working, done and blocker. */
export const boardFixture: KanbanBoardSource = {
	revision: 7,
	queue: { state: "running", waiting: 1, handedRunId: "run-w" },
	runnable: true,
	cards: [
		card("a", { title: "README の手順修正" }),
		card("b", { title: "ログ出力の見直し" }),
		card("w", {
			title: "API の型を整理",
			column: "running",
			currentRunId: "run-w",
			actions: ["stop", "open"],
		}),
		card("q", {
			title: "依存パッケージの確認",
			column: "running",
			currentRunId: "run-q",
			actions: ["cancel"],
		}),
		card("d", {
			title: "テストの追加",
			column: "finished",
			label: "done",
			lastReport: "テストを3件追加しました。",
			files: ["api/domains/kanban/test/kanban.test.ts"],
			actions: ["review", "followup", "commitPush", "reset", "edit", "remove"],
		}),
		card("x", {
			title: "移行スクリプトの実行",
			column: "finished",
			label: "blocker",
			reason: "send_failed",
			actions: ["run", "reset", "edit", "remove"],
		}),
	],
	runs: [
		{
			id: "run-w",
			state: "handed",
			requestState: "started",
			activity: "working",
			createdAt: "2026-10-14T01:00:00Z",
		},
		{
			id: "run-q",
			state: "waiting_turn",
			createdAt: "2026-10-14T01:05:00Z",
		},
	],
};
