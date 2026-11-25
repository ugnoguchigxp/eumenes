import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { KanbanNoticeView } from "./NotificationCenter";
import type { TimerNotificationDto } from "../../../../../api/domains/timers/contracts";
import { NotificationCenter } from "./NotificationCenter";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const timer = (
	over: Partial<TimerNotificationDto> = {},
): TimerNotificationDto => ({
	id: "t1",
	timerId: "timer-1",
	revision: 2,
	status: "played",
	dueAt: "2026-10-14T10:00:00.000Z",
	reason: null,
	generation: 1,
	message: "3分のタイマーが終了しました。",
	...over,
});
const notice = (over: Partial<KanbanNoticeView> = {}): KanbanNoticeView => ({
	id: "n1",
	kind: "done",
	cardId: "c1",
	runId: "r1",
	text: "タスク『README の手順修正』が終わりました",
	read: false,
	createdAt: "2026-10-14T11:00:00.000Z",
	...over,
});

function show(
	over: {
		notices?: TimerNotificationDto[];
		kanban?: KanbanNoticeView[];
		unread?: number;
		reading?: string[];
		loadError?: string;
		error?: string;
		onPrepareAudio?: () => void;
	} = {},
) {
	const onStop = vi.fn();
	const onRead = vi.fn();
	const onOpenBoard = vi.fn();
	const component = (options = over) => {
		const items = options.kanban ?? [];
		return (
			<StrictMode>
				<NotificationCenter
					notices={options.notices ?? []}
					kanban={{
						notices: items,
						unread: options.unread ?? items.filter((n) => !n.read).length,
						readingIds: options.reading ?? [],
						error: null,
						loadError: options.loadError ?? null,
						onOpenBoard,
						onRead,
					}}
					ringingId={null}
					stoppingIds={[]}
					onStop={onStop}
					error={options.error ?? null}
					onPrepareAudio={options.onPrepareAudio}
				/>
			</StrictMode>
		);
	};
	const view = render(component());
	return {
		onStop,
		onRead,
		onOpenBoard,
		update: (options: typeof over) => view.rerender(component(options)),
	};
}

test("timer and Kanban notices share one drawer, newest first, with the unread count on the button", async () => {
	show({
		notices: [timer()],
		kanban: [
			notice({ id: "n1" }),
			notice({
				id: "n2",
				kind: "blocker",
				text: "タスク『B』が止まりました: 許可待ち",
				read: true,
				createdAt: "2026-10-14T09:00:00.000Z",
			}),
		],
	});
	// One timer notice plus one unread Kanban notice; the read one is not counted.
	fireEvent.click(screen.getByRole("button", { name: "通知センター、2件" }));
	const drawer = await screen.findByRole("dialog", { name: "通知センター" });
	const titles = Array.from(drawer.querySelectorAll("article h3")).map(
		(h) => h.textContent,
	);
	expect(titles).toEqual([
		"タスクが完了しました",
		"タイマーが終了しました",
		"タスクが止まりました",
	]);
	expect(drawer.textContent).toContain("3件の通知");
	expect(drawer.textContent).toContain("既読");
});

test("a Kanban notice opens the board and is marked read; timers keep their stop action", async () => {
	const h = show({
		notices: [timer()],
		kanban: [notice(), notice({ id: "n2", read: true })],
	});
	fireEvent.click(screen.getByRole("button", { name: /通知センター/ }));
	const drawer = await screen.findByRole("dialog", { name: "通知センター" });
	// A read notice offers no read button; the unread one does.
	expect(drawer).toBeTruthy();
	const open = screen.getAllByRole("button", { name: "タスクボードを開く" });
	expect(open).toHaveLength(2);
	fireEvent.click(open[0]!);
	expect(h.onOpenBoard).toHaveBeenCalledOnce();
	const read = screen.getAllByRole("button", { name: "既読にする" });
	expect(read).toHaveLength(1);
	fireEvent.click(read[0]!);
	expect(h.onRead).toHaveBeenCalledWith(expect.objectContaining({ id: "n1" }));
	fireEvent.click(screen.getByRole("button", { name: "通知を停止" }));
	expect(h.onStop).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }));
});

test("unread Kanban notices appear in the floating stack; read ones do not", () => {
	show({ kanban: [notice(), notice({ id: "n2", read: true })] });
	const stack = screen.getByRole("status", { name: "新しい通知" });
	expect(stack.querySelectorAll("article")).toHaveLength(1);
	expect(stack.textContent).toContain("README の手順修正");
});

test("only timers keep the timer-specific stack label and empty drawer text", async () => {
	show({ notices: [timer()] });
	expect(screen.getByRole("status", { name: "タイマーの終了" })).toBeTruthy();
	cleanup();
	show();
	expect(screen.queryByRole("status")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "通知センター" }));
	await screen.findByText("通知はありません");
});

test("a notice being marked read disables its button", () => {
	show({ kanban: [notice()], reading: ["n1"] });
	const button = screen.getByRole("button", { name: "処理中…" });
	expect((button as HTMLButtonElement).disabled).toBe(true);
});

test("a list load failure shows in the drawer only, never over the screen", async () => {
	show({ loadError: "タスクの通知を取得できませんでした。" });
	expect(screen.queryByRole("alert")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "通知センター" }));
	await screen.findByText("タスクの通知を取得できませんでした。");
});

test("banners collapse after eight seconds without acknowledging notices; the badge and drawer actions remain", () => {
	vi.useFakeTimers();
	const h = show({ notices: [timer()], kanban: [notice()] });
	act(() => vi.advanceTimersByTime(7_999));
	expect(screen.getByRole("status").querySelectorAll("article")).toHaveLength(
		2,
	);
	act(() => vi.advanceTimersByTime(1));
	expect(screen.queryByRole("status")).toBeNull();
	const trigger = screen.getByRole("button", { name: "通知センター、2件" });
	expect(trigger.querySelector(".notification-center-badge")?.textContent).toBe(
		"2",
	);
	expect(h.onRead).not.toHaveBeenCalled();
	expect(h.onStop).not.toHaveBeenCalled();
	fireEvent.click(trigger);
	expect(screen.getByRole("dialog").querySelectorAll("article")).toHaveLength(
		2,
	);
	fireEvent.click(screen.getByRole("button", { name: "通知を停止" }));
	fireEvent.click(screen.getByRole("button", { name: "既読にする" }));
	expect(h.onStop).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }));
	expect(h.onRead).toHaveBeenCalledWith(expect.objectContaining({ id: "n1" }));
	fireEvent.click(screen.getByRole("button", { name: "通知センターを閉じる" }));
	expect(screen.queryByRole("status")).toBeNull();
});

test("refreshes do not extend a banner; a later notice gets its own deadline even with the same id in another source", () => {
	vi.useFakeTimers();
	const h = show({ notices: [timer()] });
	act(() => vi.advanceTimersByTime(4_000));
	h.update({
		notices: [timer({ revision: 3 })],
		kanban: [notice({ id: "t1" })],
	});
	act(() => vi.advanceTimersByTime(4_000));
	expect(screen.queryByText("3分のタイマーが終了しました。")).toBeNull();
	expect(
		screen.getByText("タスク『README の手順修正』が終わりました"),
	).toBeTruthy();
	act(() => vi.advanceTimersByTime(4_000));
	expect(screen.queryByRole("status")).toBeNull();
	h.update({ notices: [timer()], kanban: [notice({ id: "t1" })] });
	expect(screen.queryByRole("status")).toBeNull();
	expect(
		screen.getByRole("button", { name: "通知センター、2件" }),
	).toBeTruthy();
	h.update({ notices: [timer()], kanban: [notice({ id: "t1", read: true })] });
	expect(
		screen.getByRole("button", { name: "通知センター、1件" }),
	).toBeTruthy();
	h.update({ notices: [], kanban: [notice({ id: "t1", read: true })] });
	expect(
		screen
			.getByRole("button", { name: "通知センター" })
			.querySelector(".notification-center-badge"),
	).toBeNull();
});

test("audio guidance and errors also collapse and remain available in the drawer", () => {
	vi.useFakeTimers();
	const prepareAudio = vi.fn();
	show({ onPrepareAudio: prepareAudio, error: "通知を停止できませんでした。" });
	expect(
		screen.getByRole("button", { name: "通知音を有効にする" }),
	).toBeTruthy();
	act(() => vi.advanceTimersByTime(8_000));
	expect(screen.queryByRole("status")).toBeNull();
	expect(screen.queryByRole("alert")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "通知センター" }));
	expect(screen.getByRole("alert").textContent).toBe(
		"通知を停止できませんでした。",
	);
	fireEvent.click(screen.getByRole("button", { name: "通知音を有効にする" }));
	expect(prepareAudio).toHaveBeenCalledOnce();
});
