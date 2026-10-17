import {
	ArtifactRenderer,
	type ArtifactEvent,
	type KanbanBoardSource,
	type Snapshot,
} from "@eumenes/artifact-ui";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { boardFixture } from "./fixtures";

afterEach(cleanup);

const definition = JSON.stringify({
	view: "kanban-board",
	source: "kanban",
	title: "タスクボード",
});

function mount(board: KanbanBoardSource = boardFixture, revision = 7) {
	const dispatch = vi.fn(async (_event: ArtifactEvent) => ({
		status: "accepted" as const,
		message: "",
	}));
	const snapshot: Snapshot = {
		kanban: { kind: "kanban-board", revision, board },
	};
	render(
		<ArtifactRenderer
			definition={definition}
			runtime={{ snapshot, dispatch }}
		/>,
	);
	return { dispatch };
}
/** A dispatch locks the board (busy) until it settles; wait before the next operation. */
const settle = () =>
	waitFor(() => expect(document.querySelector("[aria-busy=true]")).toBeNull());
const cardOf = (title: string) => screen.getByRole("article", { name: title });

test("the snapshot is drawn in three columns with the wording of each run state", () => {
	mount();
	expect(screen.getByRole("heading", { name: "タスクボード" })).toBeDefined();
	const lists = (name: string) =>
		within(screen.getByRole("list", { name }))
			.getAllByRole("heading", { level: 4 })
			.map((h) => h.textContent);
	expect(lists("未着手＋Planningのタスク")).toEqual([
		"README の手順修正",
		"ログ出力の見直し",
	]);
	expect(lists("Ongoingのタスク")).toEqual([
		"API の型を整理",
		"依存パッケージの確認",
	]);
	expect(lists("Done・Blockerのタスク")).toEqual([
		"テストの追加",
		"移行スクリプトの実行",
	]);
	expect(within(cardOf("API の型を整理")).getByText("作業中")).toBeDefined();
	expect(
		within(cardOf("依存パッケージの確認")).getByText("キュー待ち（1番目）"),
	).toBeDefined();
	expect(within(cardOf("テストの追加")).getByText("Done")).toBeDefined();
	const blocker = cardOf("移行スクリプトの実行");
	expect(within(blocker).getByText("Blocker")).toBeDefined();
	expect(within(blocker).getByText("送信に失敗しました")).toBeDefined();
	expect(screen.getByText(/実行中: 「API の型を整理」/)).toBeDefined();
});

test("run states are worded for waiting, sending and unconfirmed stops", () => {
	const running = (state: Partial<KanbanBoardSource["runs"][number]>) => ({
		...boardFixture,
		runs: [
			{
				id: "run-w",
				state: "handed" as const,
				createdAt: "2026-10-14T01:00:00Z",
				...state,
			},
		],
	});
	const view = render(<></>);
	view.unmount();
	for (const [state, text] of [
		[{ activity: "waiting" as const }, "許可を待っています"],
		[{ requestState: "queued" }, "送信待ち"],
		[{ requestState: "started", activity: "working" as const }, "作業中"],
	] as const) {
		mount(running(state));
		expect(within(cardOf("API の型を整理")).getByText(text)).toBeDefined();
		cleanup();
	}
	mount({
		...running({ activity: "working" }),
		queue: {
			state: "paused",
			reason: "stop_unconfirmed",
			waiting: 0,
			handedRunId: "run-w",
		},
	});
	expect(
		within(cardOf("API の型を整理")).getByText("停止を確認中"),
	).toBeDefined();
	expect(screen.getByRole("status").textContent).toContain(
		"実行キューは停止中: 止めたタスクの終了を確認できていません",
	);
});

test("an untracked host disables run actions and says why", () => {
	mount({ ...boardFixture, runnable: false });
	expect(screen.getByRole("status").textContent).toContain(
		"この環境では作業の状態を追えないため実行できません",
	);
	expect(
		(
			within(cardOf("README の手順修正")).getByRole("button", {
				name: "実行",
			}) as HTMLButtonElement
		).disabled,
	).toBe(true);
	expect(
		(
			within(cardOf("README の手順修正")).getByRole("button", {
				name: "Claude Code を開く",
			}) as HTMLButtonElement
		).disabled,
	).toBe(false);
});

test("add, edit and move are sent as kanban events with decimal-string revisions", async () => {
	const { dispatch } = mount();
	fireEvent.click(screen.getByRole("button", { name: "タスクを追加" }));
	fireEvent.change(screen.getByLabelText("タイトル"), {
		target: { value: "新しい作業" },
	});
	fireEvent.change(screen.getByLabelText("依頼内容"), {
		target: { value: "手順を直す" },
	});
	fireEvent.click(screen.getByRole("button", { name: "追加" }));
	await settle();
	expect(dispatch).toHaveBeenLastCalledWith(
		expect.objectContaining({
			source: "kanban",
			revision: 7,
			action: "kanban-add",
			values: { title: "新しい作業", prompt: "手順を直す" },
		}),
	);

	fireEvent.click(
		within(cardOf("README の手順修正")).getByRole("button", { name: "編集" }),
	);
	const prompt = screen.getByLabelText("依頼内容");
	fireEvent.change(prompt, { target: { value: "新しい依頼" } });
	fireEvent.click(screen.getByRole("button", { name: "保存" }));
	await settle();
	expect(dispatch).toHaveBeenLastCalledWith(
		expect.objectContaining({
			action: "kanban-edit",
			values: { cardId: "a", expectedRevision: "2", prompt: "新しい依頼" },
		}),
	);

	fireEvent.click(
		within(cardOf("ログ出力の見直し")).getByRole("button", { name: "移動" }),
	);
	fireEvent.change(screen.getByLabelText("位置"), { target: { value: "a" } });
	fireEvent.click(screen.getByRole("button", { name: "移動する" }));
	await settle();
	expect(dispatch).toHaveBeenLastCalledWith(
		expect.objectContaining({
			action: "kanban-move",
			values: {
				cardId: "b",
				expectedRevision: "2",
				column: "todo",
				beforeCardId: "a",
			},
		}),
	);
	fireEvent.click(
		within(cardOf("README の手順修正")).getByRole("button", { name: "移動" }),
	);
	fireEvent.click(screen.getByRole("radio", { name: "Done・Blocker" }));
	fireEvent.click(screen.getByRole("button", { name: "移動する" }));
	await settle();
	expect(dispatch).toHaveBeenLastCalledWith(
		expect.objectContaining({
			action: "kanban-move",
			values: {
				cardId: "a",
				expectedRevision: "2",
				column: "finished",
				beforeCardId: "",
			},
		}),
	);
});

test("card actions map to their events; open carries only the card id", async () => {
	const { dispatch } = mount();
	const last = () => dispatch.mock.lastCall?.[0];
	fireEvent.click(
		within(cardOf("README の手順修正")).getByRole("button", { name: "実行" }),
	);
	await settle();
	expect(last()).toMatchObject({
		action: "kanban-run",
		values: { cardId: "a", expectedRevision: "2" },
	});
	fireEvent.click(
		within(cardOf("依存パッケージの確認")).getByRole("button", {
			name: "取消",
		}),
	);
	await settle();
	expect(last()).toMatchObject({
		action: "kanban-cancel",
		values: { cardId: "q", expectedRevision: "2" },
	});
	fireEvent.click(
		within(cardOf("API の型を整理")).getByRole("button", {
			name: "止めて Blocker にする",
		}),
	);
	await settle();
	expect(last()).toMatchObject({ action: "kanban-stop" });
	fireEvent.click(
		within(cardOf("API の型を整理")).getByRole("button", {
			name: "Claude Code を開く",
		}),
	);
	await settle();
	expect(last()).toEqual(
		expect.objectContaining({ action: "kanban-open", values: { cardId: "w" } }),
	);
	fireEvent.click(
		within(cardOf("テストの追加")).getByRole("button", {
			name: "確認済みにする",
		}),
	);
	await settle();
	expect(last()).toMatchObject({ action: "kanban-review" });
	fireEvent.click(
		within(cardOf("移行スクリプトの実行")).getByRole("button", {
			name: "未着手へ戻す",
		}),
	);
	await settle();
	expect(last()).toMatchObject({ action: "kanban-reset" });
	fireEvent.click(
		within(cardOf("README の手順修正")).getByRole("button", { name: "削除" }),
	);
	fireEvent.click(screen.getByRole("button", { name: "削除する" }));
	await settle();
	expect(last()).toMatchObject({
		action: "kanban-remove",
		values: { cardId: "a", expectedRevision: "2" },
	});
});

test("follow-up carries the note, commit & push waits for the confirmation, resume has no values", async () => {
	const { dispatch } = mount({
		...boardFixture,
		queue: { state: "paused", reason: "tracking_lost", waiting: 0 },
	});
	fireEvent.click(
		within(cardOf("テストの追加")).getByRole("button", { name: "追加で直す" }),
	);
	fireEvent.change(screen.getByLabelText("追加の依頼"), {
		target: { value: "型も直して" },
	});
	fireEvent.click(screen.getByRole("button", { name: "送る" }));
	await settle();
	expect(dispatch).toHaveBeenLastCalledWith(
		expect.objectContaining({
			action: "kanban-followup",
			values: { cardId: "d", expectedRevision: "2", note: "型も直して" },
		}),
	);
	dispatch.mockClear();
	fireEvent.click(
		within(cardOf("テストの追加")).getByRole("button", {
			name: "commit & push",
		}),
	);
	expect(dispatch).not.toHaveBeenCalled();
	const dialog = screen.getByRole("dialog");
	expect(
		within(dialog).getByText("api/domains/kanban/test/kanban.test.ts"),
	).toBeDefined();
	expect(within(dialog).getByText("テストを3件追加しました。")).toBeDefined();
	fireEvent.click(
		within(dialog).getByRole("button", { name: "commit & push を依頼する" }),
	);
	await settle();
	expect(dispatch).toHaveBeenLastCalledWith(
		expect.objectContaining({
			action: "kanban-commit-push",
			values: { cardId: "d", expectedRevision: "2" },
		}),
	);
	expect(screen.getByRole("status").textContent).toContain(
		"状態を追えないため止めました",
	);
	fireEvent.click(screen.getByRole("button", { name: "再開" }));
	await settle();
	expect(dispatch).toHaveBeenLastCalledWith(
		expect.objectContaining({ action: "kanban-resume-queue", values: {} }),
	);
});

test("a rejected action shows the host's message", async () => {
	const dispatch = vi.fn(async () => ({
		status: "conflict" as const,
		message: "他の操作でタスクの状態が変わりました。",
	}));
	render(
		<ArtifactRenderer
			definition={definition}
			runtime={{
				snapshot: {
					kanban: { kind: "kanban-board", revision: 7, board: boardFixture },
				},
				dispatch,
			}}
		/>,
	);
	fireEvent.click(
		within(cardOf("README の手順修正")).getByRole("button", { name: "実行" }),
	);
	await settle();
	expect((await screen.findByRole("alert")).textContent).toContain(
		"他の操作でタスクの状態が変わりました。",
	);
});

test("work typed by hand in a Claude Code session is named in the queue line, or said to be ignored when stale", () => {
	mount({
		...boardFixture,
		queue: {
			state: "running",
			waiting: 1,
			manual: { activity: "working", stale: false },
		},
	});
	expect(screen.getByText(/手入力の作業が続いています/)).toBeDefined();
	cleanup();
	mount({
		...boardFixture,
		queue: {
			state: "running",
			waiting: 1,
			manual: { activity: "waiting", stale: true },
		},
	});
	expect(screen.getByText(/状態が古いため、待たずに/)).toBeDefined();
});
