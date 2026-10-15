import {
	cleanup,
	createEvent,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { KanbanBoard } from "./KanbanBoard";
import {
	baseProps,
	blockerCard,
	card,
	cardA,
	cardB,
	cardC,
	doneCard,
	longReport,
	runningCard,
	todoCards,
} from "./KanbanBoard.fixtures";
import type { KanbanBoardProps } from "./types";

afterEach(cleanup);

function setup(over: Partial<KanbanBoardProps> = {}) {
	const handlers = {
		onAdd: vi.fn(),
		onEdit: vi.fn(),
		onMove: vi.fn(),
		onAction: vi.fn(),
		onResumeQueue: vi.fn(),
	};
	const props = { ...baseProps, ...handlers, ...over };
	const view = render(<KanbanBoard {...props} />);
	return {
		...handlers,
		view,
		user: userEvent.setup(),
		props,
		again: (next: Partial<KanbanBoardProps>) =>
			view.rerender(<KanbanBoard {...props} {...next} />),
	};
}
const cardOf = (title: string) => screen.getByRole("article", { name: title });
const titles = (list: string) =>
	within(screen.getByRole("list", { name: list }))
		.getAllByRole("heading", { level: 4 })
		.map((h) => h.textContent);

test("three columns hold the cards with Done and Blocker named by text", () => {
	setup({ cards: [...todoCards, runningCard, doneCard, blockerCard] });
	expect(titles("未着手のタスク")).toEqual([
		"README の手順修正",
		"ログ出力の見直し",
		"設定画面の文言統一",
	]);
	expect(titles("実行中のタスク")).toEqual(["API の型を整理"]);
	expect(titles("Done・Blockerのタスク")).toEqual([
		"テストの追加",
		"移行スクリプトの実行",
	]);
	expect(within(cardOf("API の型を整理")).getByText("作業中")).toBeVisible();
	expect(within(cardOf("テストの追加")).getByText("Done")).toBeVisible();
	const blocker = cardOf("移行スクリプトの実行");
	expect(within(blocker).getByText("Blocker")).toBeVisible();
	expect(within(blocker).getByText(/途中で止まりました/)).toBeVisible();
	expect(screen.getByRole("region", { name: "未着手" })).toBeVisible();
});

test("queue status shows the running card, waiting count and the paused reason with resume", async () => {
	const running = setup({
		queue: { state: "running", waiting: 2, runningTitle: "API の型を整理" },
	});
	expect(
		screen.getByText("実行中: 「API の型を整理」・待機中 2件"),
	).toBeVisible();
	expect(screen.queryByRole("button", { name: "再開" })).toBeNull();
	running.view.unmount();
	const paused = setup({
		queue: {
			state: "paused",
			reasonText: "状態を追えないため止めました",
			waiting: 1,
		},
	});
	expect(screen.getByRole("status")).toHaveTextContent(
		"実行キューは停止中: 状態を追えないため止めました",
	);
	await paused.user.click(screen.getByRole("button", { name: "再開" }));
	expect(paused.onResumeQueue).toHaveBeenCalledOnce();
});

test("the add form needs a title and a prompt and sends trimmed values", async () => {
	const { user, onAdd } = setup();
	await user.click(screen.getByRole("button", { name: "タスクを追加" }));
	const form = screen.getByRole("form", { name: "タスクを追加" });
	const submit = within(form).getByRole("button", { name: "追加" });
	expect(within(form).getByLabelText("タイトル")).toHaveFocus();
	expect(submit).toBeDisabled();
	await user.type(within(form).getByLabelText("タイトル"), "  新しい作業 ");
	expect(submit).toBeDisabled();
	await user.type(within(form).getByLabelText("依頼内容"), "手順を直す ");
	await user.click(submit);
	expect(onAdd).toHaveBeenCalledWith({
		title: "新しい作業",
		prompt: "手順を直す",
	});
	expect(screen.queryByRole("form", { name: "タスクを追加" })).toBeNull();
	expect(screen.getByRole("button", { name: "タスクを追加" })).toHaveFocus();
});

test("escape closes the add form and returns focus to the add button", async () => {
	const { user, onAdd } = setup();
	await user.click(screen.getByRole("button", { name: "タスクを追加" }));
	await user.keyboard("{Escape}");
	expect(screen.queryByRole("form")).toBeNull();
	expect(screen.getByRole("button", { name: "タスクを追加" })).toHaveFocus();
	expect(onAdd).not.toHaveBeenCalled();
});

test("editing sends only the changed fields with the card revision", async () => {
	const { user, onEdit } = setup({
		cards: [{ ...cardA, revision: 4 }],
	});
	await user.click(
		within(cardOf("README の手順修正")).getByRole("button", { name: "編集" }),
	);
	const form = screen.getByRole("form", {
		name: "「README の手順修正」を編集",
	});
	const save = within(form).getByRole("button", { name: "保存" });
	expect(save).toBeDisabled();
	const prompt = within(form).getByLabelText("依頼内容");
	await user.clear(prompt);
	await user.type(prompt, "新しい依頼");
	await user.click(save);
	expect(onEdit).toHaveBeenCalledWith("a", 4, { prompt: "新しい依頼" });
	expect(cardOf("README の手順修正")).toHaveFocus();
});

test("the move menu picks a column and a position and emits beforeCardId", async () => {
	const { user, onMove } = setup({
		cards: [{ ...cardA, revision: 3 }, cardB, cardC, doneCard],
	});
	await user.click(
		within(cardOf("設定画面の文言統一")).getByRole("button", { name: "移動" }),
	);
	const form = screen.getByRole("form", { name: "移動先を選ぶ" });
	const submit = within(form).getByRole("button", { name: "移動する" });
	expect(submit).toBeDisabled(); // still where it already is
	await user.selectOptions(within(form).getByLabelText("位置"), "a");
	await user.click(submit);
	expect(onMove).toHaveBeenCalledWith("c", 1, "todo", "a");
	expect(cardOf("設定画面の文言統一")).toHaveFocus();
});

test("the move menu can send a card to the end of the other column", async () => {
	const { user, onMove } = setup({ cards: [...todoCards, doneCard] });
	await user.click(
		within(cardOf("README の手順修正")).getByRole("button", { name: "移動" }),
	);
	const form = screen.getByRole("form", { name: "移動先を選ぶ" });
	await user.click(within(form).getByRole("radio", { name: "Done・Blocker" }));
	expect(within(form).getByLabelText("位置")).toHaveValue("");
	await user.click(within(form).getByRole("button", { name: "移動する" }));
	expect(onMove).toHaveBeenCalledWith("a", 1, "finished", null);
});

test("cancelling the move menu returns focus to its button", async () => {
	const { user, onMove } = setup({ cards: todoCards });
	const button = within(cardOf("ログ出力の見直し")).getByRole("button", {
		name: "移動",
	});
	await user.click(button);
	await user.keyboard("{Escape}");
	expect(screen.queryByRole("form")).toBeNull();
	expect(
		within(cardOf("ログ出力の見直し")).getByRole("button", { name: "移動" }),
	).toHaveFocus();
	expect(onMove).not.toHaveBeenCalled();
});

test("running cards cannot be moved", () => {
	setup({ cards: [runningCard] });
	expect(
		within(cardOf("API の型を整理")).queryByRole("button", { name: "移動" }),
	).toBeNull();
	expect(cardOf("API の型を整理")).not.toHaveAttribute("draggable", "true");
});

test("alt+arrow keys reorder a focused card inside its column", async () => {
	const { user, onMove } = setup({ cards: todoCards });
	cardOf("ログ出力の見直し").focus();
	await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
	expect(onMove).toHaveBeenLastCalledWith("b", 1, "todo", "a");
	await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
	expect(onMove).toHaveBeenLastCalledWith("b", 1, "todo", null);
	cardOf("README の手順修正").focus();
	await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
	expect(onMove).toHaveBeenCalledTimes(2);
	await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
	expect(onMove).toHaveBeenLastCalledWith("a", 1, "todo", "c");
});

test("a focused card keeps focus after the host redraws it elsewhere", async () => {
	const { user, again } = setup({ cards: todoCards });
	cardOf("ログ出力の見直し").focus();
	await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
	// The old node is gone, as when the card changes column.
	cardOf("ログ出力の見直し").blur();
	again({ cards: [cardB, cardA, cardC] });
	expect(cardOf("ログ出力の見直し")).toHaveFocus();
});

/** jsdom has no DragEvent, so the pointer position is attached to the event by hand. */
function dragAt(
	type: "dragOver" | "drop",
	element: HTMLElement,
	clientY: number,
	dataTransfer: object,
) {
	const event = createEvent[type](element, { dataTransfer });
	Object.defineProperty(event, "clientY", { value: clientY });
	fireEvent(element, event);
}

function dragFixture() {
	const view = setup({ cards: [...todoCards, doneCard] });
	const rect = (title: string, top: number) => {
		const li = cardOf(title).closest("li") as HTMLElement;
		li.getBoundingClientRect = () =>
			({ top, height: 40, bottom: top + 40 }) as DOMRect;
	};
	rect("README の手順修正", 0);
	rect("ログ出力の見直し", 50);
	rect("設定画面の文言統一", 100);
	rect("テストの追加", 0);
	return view;
}

test("dropping a dragged card turns the pointer position into beforeCardId", () => {
	const { onMove } = dragFixture();
	const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
	const todo = screen.getByRole("list", { name: "未着手のタスク" });
	fireEvent.dragStart(cardOf("設定画面の文言統一"), { dataTransfer });
	dragAt("dragOver", todo, 60, dataTransfer);
	expect(todo.querySelector(".kanban-drop-line")).not.toBeNull();
	dragAt("drop", todo, 60, dataTransfer);
	expect(onMove).toHaveBeenCalledWith("c", 1, "todo", "b");
});

test("dropping below the last card or in the other column goes to the end", () => {
	const { onMove } = dragFixture();
	const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
	fireEvent.dragStart(cardOf("README の手順修正"), { dataTransfer });
	dragAt(
		"drop",
		screen.getByRole("list", { name: "Done・Blockerのタスク" }),
		500,
		dataTransfer,
	);
	expect(onMove).toHaveBeenCalledWith("a", 1, "finished", null);
});

test("dropping a card where it already is, or in the running column, does nothing", () => {
	const { onMove } = dragFixture();
	const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
	fireEvent.dragStart(cardOf("設定画面の文言統一"), { dataTransfer });
	dragAt(
		"drop",
		screen.getByRole("list", { name: "未着手のタスク" }),
		900,
		dataTransfer,
	);
	fireEvent.dragStart(cardOf("README の手順修正"), { dataTransfer });
	dragAt(
		"drop",
		screen.getByRole("list", { name: "実行中のタスク" }),
		0,
		dataTransfer,
	);
	expect(onMove).not.toHaveBeenCalled();
});

test("card actions go to onAction with the card revision", async () => {
	const { user, onAction } = setup({
		cards: [
			{ ...cardA, revision: 2 },
			{ ...runningCard, revision: 5, actions: ["stop", "open", "cancel"] },
			{ ...blockerCard, revision: 7 },
		],
	});
	await user.click(
		within(cardOf("README の手順修正")).getByRole("button", { name: "実行" }),
	);
	expect(onAction).toHaveBeenLastCalledWith("run", "a", 2);
	const running = within(cardOf("API の型を整理"));
	await user.click(running.getByRole("button", { name: "取消" }));
	expect(onAction).toHaveBeenLastCalledWith("cancel", "r", 5);
	await user.click(
		running.getByRole("button", { name: "止めて Blocker にする" }),
	);
	expect(onAction).toHaveBeenLastCalledWith("stop", "r", 5);
	await user.click(running.getByRole("button", { name: "Claude Code を開く" }));
	expect(onAction).toHaveBeenLastCalledWith("open", "r", 5);
	const blocker = within(cardOf("移行スクリプトの実行"));
	await user.click(blocker.getByRole("button", { name: "やり直す" }));
	expect(onAction).toHaveBeenLastCalledWith("run", "x", 7);
	await user.click(blocker.getByRole("button", { name: "未着手へ戻す" }));
	expect(onAction).toHaveBeenLastCalledWith("reset", "x", 7);
});

test("deleting asks first", async () => {
	const { user, onAction } = setup({ cards: [cardA] });
	const target = within(cardOf("README の手順修正"));
	await user.click(target.getByRole("button", { name: "削除" }));
	expect(onAction).not.toHaveBeenCalled();
	await user.click(target.getByRole("button", { name: "やめる" }));
	await user.click(target.getByRole("button", { name: "削除" }));
	await user.click(target.getByRole("button", { name: "削除する" }));
	expect(onAction).toHaveBeenCalledWith("remove", "a", 1);
});

test("a follow-up needs a note and sends it with the action", async () => {
	const { user, onAction } = setup({ cards: [{ ...doneCard, revision: 3 }] });
	await user.click(
		within(cardOf("テストの追加")).getByRole("button", { name: "追加で直す" }),
	);
	const form = screen.getByRole("form", { name: "追加で直す" });
	const send = within(form).getByRole("button", { name: "送る" });
	expect(send).toBeDisabled();
	await user.type(within(form).getByLabelText("追加の依頼"), " 型も直して ");
	await user.click(send);
	expect(onAction).toHaveBeenCalledWith("followup", "d", 3, {
		note: "型も直して",
	});
});

test("not runnable disables the run actions and says why, while open stays usable", () => {
	setup({
		cards: [cardA, { ...doneCard }, { ...runningCard, actions: ["open"] }],
		runnable: false,
		notRunnableText: "この環境では作業の状態を追えません",
	});
	expect(screen.getByRole("status")).toHaveTextContent(
		"この環境では作業の状態を追えません",
	);
	expect(
		within(cardOf("README の手順修正")).getByRole("button", { name: "実行" }),
	).toBeDisabled();
	const done = within(cardOf("テストの追加"));
	expect(done.getByRole("button", { name: "追加で直す" })).toBeDisabled();
	expect(done.getByRole("button", { name: "commit & push" })).toBeDisabled();
	expect(done.getByRole("button", { name: "確認済みにする" })).toBeEnabled();
	expect(
		within(cardOf("API の型を整理")).getByRole("button", {
			name: "Claude Code を開く",
		}),
	).toBeEnabled();
});

test("commit & push shows the files and the last report and sends only after confirmation", async () => {
	const { user, onAction } = setup({ cards: [{ ...doneCard, revision: 6 }] });
	await user.click(
		within(cardOf("テストの追加")).getByRole("button", {
			name: "commit & push",
		}),
	);
	expect(onAction).not.toHaveBeenCalled();
	const dialog = screen.getByRole("dialog", { name: "commit & push の確認" });
	expect(
		within(dialog).getByText("api/domains/kanban/test/kanban.test.ts"),
	).toBeVisible();
	expect(within(dialog).getByText("docs/kanban.md")).toBeVisible();
	expect(
		within(dialog).getByText("テストを3件追加し、すべて通りました。"),
	).toBeVisible();
	await user.click(within(dialog).getByRole("button", { name: "キャンセル" }));
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(onAction).not.toHaveBeenCalled();
	await user.click(
		within(cardOf("テストの追加")).getByRole("button", {
			name: "commit & push",
		}),
	);
	await user.click(
		screen.getByRole("button", { name: "commit & push を依頼する" }),
	);
	expect(onAction).toHaveBeenCalledOnce();
	expect(onAction).toHaveBeenCalledWith("commitPush", "d", 6);
	expect(screen.queryByRole("dialog")).toBeNull();
});

test("commit & push sends the revision the person confirmed; a card that changed meanwhile must be confirmed again", async () => {
	const { user, onAction, again } = setup({
		cards: [{ ...doneCard, revision: 6 }],
	});
	await user.click(
		within(cardOf("テストの追加")).getByRole("button", {
			name: "commit & push",
		}),
	);
	// The card changed while the dialog was open (new files, new revision).
	again({
		cards: [
			{
				...doneCard,
				revision: 7,
				files: ["other.ts"],
				lastReport: "別の報告",
			},
		],
	});
	const dialog = screen.getByRole("dialog", { name: "commit & push の確認" });
	expect(within(dialog).getByRole("alert")).toHaveTextContent(
		"確認している間にタスクの内容が変わりました",
	);
	// What was confirmed is still what is shown, and it cannot be sent.
	expect(within(dialog).getByText("docs/kanban.md")).toBeVisible();
	expect(
		within(dialog).queryByRole("button", { name: "commit & push を依頼する" }),
	).toBeNull();
	await user.click(
		within(dialog).getByRole("button", { name: "最新の内容を確認する" }),
	);
	expect(onAction).not.toHaveBeenCalled();
	expect(within(dialog).queryByRole("alert")).toBeNull();
	expect(within(dialog).getByText("other.ts")).toBeVisible();
	expect(within(dialog).getByText("別の報告")).toBeVisible();
	await user.click(
		within(dialog).getByRole("button", { name: "commit & push を依頼する" }),
	);
	expect(onAction).toHaveBeenCalledOnce();
	expect(onAction).toHaveBeenCalledWith("commitPush", "d", 7);
});

test("confirming unchanged sends the shown revision, and a card that can no longer be pushed closes the dialog on refresh", async () => {
	const { user, onAction, again } = setup({
		cards: [{ ...doneCard, revision: 6 }],
	});
	await user.click(
		within(cardOf("テストの追加")).getByRole("button", {
			name: "commit & push",
		}),
	);
	again({
		cards: [{ ...doneCard, revision: 8, actions: ["reset"] }],
	});
	await user.click(
		screen.getByRole("button", { name: "最新の内容を確認する" }),
	);
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(onAction).not.toHaveBeenCalled();
});

test("the prompt form shows the characters left under the host limit; a follow-up note counts escapes", async () => {
	const { user, onAdd, onAction } = setup({
		cards: [{ ...doneCard, revision: 3 }],
	});
	await user.click(screen.getByRole("button", { name: "タスクを追加" }));
	const form = screen.getByRole("form", { name: "タスクを追加" });
	const prompt = within(form).getByLabelText("依頼内容");
	expect(prompt).toHaveAttribute("maxlength", "7850");
	expect(within(form).getByText("残り 7850 字")).toBeVisible();
	await user.type(within(form).getByLabelText("タイトル"), "T");
	await user.type(prompt, "あいう");
	expect(within(form).getByText("残り 7847 字")).toBeVisible();
	await user.click(within(form).getByRole("button", { name: "追加" }));
	expect(onAdd).toHaveBeenCalledOnce();

	await user.click(
		within(cardOf("テストの追加")).getByRole("button", { name: "追加で直す" }),
	);
	const note = screen.getByRole("form", { name: "追加で直す" });
	const box = within(note).getByLabelText("追加の依頼");
	// Line breaks are escaped in the request: 3300 of them take 6600 of the room.
	fireEvent.change(box, { target: { value: `x${"\n".repeat(3300)}y` } });
	expect(within(note).getByRole("alert")).toHaveTextContent("長すぎます");
	expect(within(note).getByRole("button", { name: "送る" })).toBeDisabled();
	fireEvent.change(box, { target: { value: `x${"\n".repeat(3000)}y` } });
	expect(within(note).queryByRole("alert")).toBeNull();
	expect(within(note).getByRole("button", { name: "送る" })).toBeEnabled();
	await user.click(within(note).getByRole("button", { name: "送る" }));
	expect(onAction).toHaveBeenCalledOnce();
});

test("work typed by hand that holds the queue back is said in the queue line", () => {
	setup({
		queue: {
			state: "running",
			waiting: 1,
			manualText: "Claude Code の画面で手入力の作業が続いています",
		},
	});
	expect(
		within(screen.getByRole("region", { name: "実行キュー" })).getByText(
			"Claude Code の画面で手入力の作業が続いています",
		),
	).toBeVisible();
});

test("details show the prompt, a scrollable report and the changed files", async () => {
	const { user } = setup({
		cards: [
			{ ...doneCard, lastReport: longReport },
			card("e", { title: "空のカード" }),
		],
	});
	const toggle = within(cardOf("テストの追加")).getByRole("button", {
		name: "詳細を見る",
	});
	expect(toggle).toHaveAttribute("aria-expanded", "false");
	await user.click(toggle);
	const detail = within(cardOf("テストの追加"));
	expect(toggle).toHaveAttribute("aria-expanded", "true");
	expect(detail.getByText("d の依頼内容")).toBeVisible();
	expect(detail.getByText(/40\. 手順 40/)).toBeInTheDocument();
	expect(detail.getByText("docs/kanban.md")).toBeVisible();
	await user.click(
		within(cardOf("空のカード")).getByRole("button", { name: "詳細を見る" }),
	);
	expect(
		within(cardOf("空のカード")).getByText("報告はまだありません。"),
	).toBeVisible();
	expect(
		within(cardOf("空のカード")).getByText("記録された変更はありません。"),
	).toBeVisible();
});

test("marks for review, commit & push and mixed changes are text", () => {
	setup({
		cards: [
			{
				...doneCard,
				reviewed: true,
				commitPushReported: true,
				followedByOtherRun: true,
			},
		],
	});
	const done = within(cardOf("テストの追加"));
	expect(done.getByText("確認済み")).toBeVisible();
	expect(done.getByText("commit & push の報告あり")).toBeVisible();
	expect(
		done.getByText("このタスクの後に別のタスクが実行されています"),
	).toBeVisible();
});

test("busy disables every control and a host message is announced", () => {
	setup({
		cards: [...todoCards, doneCard],
		busy: true,
		message: "状態が変わりました。もう一度お試しください。",
	});
	expect(screen.getByRole("alert")).toHaveTextContent("状態が変わりました");
	for (const button of screen.getAllByRole("button", {
		name: /^(実行|編集|削除|移動|タスクを追加)$/,
	}))
		expect(button).toBeDisabled();
	expect(cardOf("README の手順修正")).not.toHaveAttribute("draggable", "true");
});

test("a registered third executor is selected explicitly and carried into add-and-run", async () => {
	const onAddAndRun = vi.fn();
	const choices = [
		{ id: "one", label: "担当A", available: true },
		{ id: "two", label: "担当B", available: true },
		{ id: "third", label: "担当C", available: true },
	];
	const { user } = setup({ executors: choices, onAddAndRun });
	await user.click(screen.getByRole("button", { name: "タスクを追加" }));
	await user.selectOptions(screen.getByLabelText("作業担当"), "third");
	await user.type(screen.getByLabelText("タイトル"), "依頼");
	await user.type(screen.getByLabelText("依頼内容"), "対象を修正する");
	await user.click(screen.getByRole("button", { name: "追加して実行" }));
	expect(onAddAndRun).toHaveBeenCalledWith({
		title: "依頼",
		prompt: "対象を修正する",
		executorId: "third",
	});
});

test("an unavailable saved selection is retained and cannot run through another executor", async () => {
	const onAddAndRun = vi.fn();
	const { user } = setup({
		defaultExecutorId: "two",
		executors: [
			{ id: "one", label: "担当A", available: true },
			{ id: "two", label: "担当B", available: false },
		],
		onAddAndRun,
	});
	await user.click(screen.getByRole("button", { name: "タスクを追加" }));
	await user.type(screen.getByLabelText("タイトル"), "依頼");
	await user.type(screen.getByLabelText("依頼内容"), "対象を修正する");
	expect((screen.getByLabelText("作業担当") as HTMLSelectElement).value).toBe(
		"two",
	);
	expect(screen.getByRole("button", { name: "追加して実行" })).toBeDisabled();
	expect(onAddAndRun).not.toHaveBeenCalled();
});

test("queue resume names its executor and display filtering does not call a write", async () => {
	const { user, onResumeQueue, onAction, onMove } = setup({
		executors: [
			{ id: "one", label: "担当A", available: true },
			{ id: "two", label: "担当B", available: true },
		],
		queues: [
			{
				executorId: "one",
				label: "担当A",
				state: "paused",
				reasonText: "確認待ち",
				waiting: 1,
			},
			{ executorId: "two", label: "担当B", state: "running", waiting: 2 },
		],
		cards: todoCards.map((card, index) => ({
			...card,
			executorId: index === 0 ? "one" : "two",
		})),
	});
	await user.click(
		within(screen.getByRole("region", { name: "担当A" })).getByRole("button", {
			name: "再開",
		}),
	);
	expect(onResumeQueue).toHaveBeenCalledWith("one");
	await user.selectOptions(screen.getByLabelText("表示する担当"), "one");
	expect(titles("未着手のタスク")).toEqual([todoCards[0]!.title]);
	expect(onAction).not.toHaveBeenCalled();
	expect(onMove).not.toHaveBeenCalled();
});
