import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { KanbanNoticeView } from "../../../../../api/domains/kanban/contracts";
import type { TimerNotificationDto } from "../../../../../api/domains/timers/contracts";
import { NotificationCenter } from "./NotificationCenter";

afterEach(cleanup);

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
	} = {},
) {
	const onStop = vi.fn();
	const onRead = vi.fn();
	const onOpenBoard = vi.fn();
	const items = over.kanban ?? [];
	render(
		<NotificationCenter
			notices={over.notices ?? []}
			kanban={{
				notices: items,
				unread: over.unread ?? items.filter((n) => !n.read).length,
				readingIds: over.reading ?? [],
				error: null,
				onOpenBoard,
				onRead,
			}}
			ringingId={null}
			stoppingIds={[]}
			onStop={onStop}
			error={null}
		/>,
	);
	return { onStop, onRead, onOpenBoard };
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
	expect(drawer.querySelectorAll("button")).toBeTruthy();
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
