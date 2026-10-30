import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useTodoNotices } from "../domains/dialogue";
import { useKanbanNotices } from "../domains/kanban/useKanbanNotices";
import { queryRoots } from "../queryKeys";
import { TimerNotifications } from "../components/domains/timers/TimerNotifications";

afterEach(cleanup);

function fixture() {
	const now = new Date().toISOString();
	let timers = [
		{
			id: "timer-note",
			timerId: "timer",
			status: "played",
			revision: 1,
			dueAt: now,
			reason: null,
			generation: 0,
			message: "タイマー終了",
		},
	];
	let kanban = [
		{
			id: "kanban-note",
			kind: "done" as const,
			text: "ボード完了",
			read: false,
			createdAt: now,
		},
	];
	let todos = [
		{
			id: "todo-note",
			conversationId: "main",
			title: "仕事完了",
			outcome: "succeeded" as const,
			summary: null,
			links: [],
			read: true,
			createdAt: now,
		},
	];
	const client = {
		identity: "archive-test",
		timers: vi.fn(async () => ({ items: [], serverNow: now })),
		timerNotifications: vi.fn(async () => ({
			items: timers,
			serverNow: now,
			nextCursor: null,
			activeTimers: 0,
		})),
		kanbanNotices: vi.fn(async () => ({
			notices: kanban,
			unread: kanban.filter((n) => !n.read).length,
		})),
		todoNotices: vi.fn(async () => ({
			notices: todos,
			unread: todos.filter((n) => !n.read).length,
		})),
		readKanbanNotice: vi.fn(async () => {}),
		readTodoNotice: vi.fn(async () => {}),
		archiveTimerNotifications: vi.fn(async () => {
			timers = [];
		}),
		archiveKanbanNotices: vi.fn(async () => {
			kanban = [];
		}),
		archiveTodoNotices: vi.fn(async () => {
			todos = [];
		}),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	const chime = vi.fn();
	const playTone = vi.fn(async () => {});
	const openById = vi.fn(async () => true);
	function Center() {
		const board = useKanbanNotices(client, chime, openById);
		const todo = useTodoNotices(client, chime);
		return (
			<TimerNotifications
				client={client as never}
				playTone={playTone}
				kanban={board}
				todo={{ ...todo, onOpen: () => {} }}
			/>
		);
	}
	const show = () =>
		render(
			<QueryClientProvider client={cache}>
				<Center />
			</QueryClientProvider>,
		);
	return {
		client,
		cache,
		chime,
		show,
		newNotice() {
			todos = [
				{
					id: "new",
					conversationId: "main",
					title: "新しい仕事",
					outcome: "succeeded",
					summary: null,
					links: [],
					read: false,
					createdAt: new Date().toISOString(),
				},
			];
		},
	};
}

test("clear archives all sources, disables repeated clicks, updates the badge, survives remount, and accepts new notices", async () => {
	const h = fixture();
	let finish!: () => void;
	const archive = h.client.archiveTodoNotices.getMockImplementation()!;
	h.client.archiveTodoNotices.mockImplementationOnce(async () => {
		await new Promise<void>((resolve) => {
			finish = resolve;
		});
		await archive();
	});
	const view = h.show();
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "通知センター、2件" }),
		).toBeTruthy(),
	);
	fireEvent.click(screen.getByRole("button", { name: "通知センター、2件" }));
	await screen.findByText("仕事完了");
	fireEvent.click(screen.getByRole("button", { name: "履歴をクリア" }));
	const pending = screen.getByRole("button", {
		name: "クリア中…",
	}) as HTMLButtonElement;
	expect(pending.disabled).toBe(true);
	fireEvent.click(pending);
	expect(h.client.archiveTimerNotifications).toHaveBeenCalledOnce();
	expect(h.client.archiveKanbanNotices).toHaveBeenCalledOnce();
	expect(h.client.archiveTodoNotices).toHaveBeenCalledOnce();
	await act(async () => finish());
	await screen.findByText("通知はありません");
	expect(
		(screen.getByRole("button", { name: "履歴をクリア" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
	fireEvent.click(screen.getByRole("button", { name: "通知センターを閉じる" }));
	expect(screen.getByRole("button", { name: "通知センター" })).toBeTruthy();
	view.unmount();
	h.show();
	fireEvent.click(screen.getByRole("button", { name: "通知センター" }));
	await screen.findByText("通知はありません");
	await waitFor(() => expect(h.client.todoNotices).toHaveBeenCalledTimes(3));
	h.newNotice();
	await act(async () => {
		await h.cache.invalidateQueries({ queryKey: [queryRoots.dialogue] });
	});
	await screen.findByText("新しい仕事");
	fireEvent.click(screen.getByRole("button", { name: "通知センターを閉じる" }));
	expect(
		screen.getByRole("button", { name: "通知センター、1件" }),
	).toBeTruthy();
	expect(h.chime).toHaveBeenCalledOnce();
});

test("a failed source stays visible with an error while successful sources clear; retry completes", async () => {
	const h = fixture();
	h.client.archiveKanbanNotices.mockRejectedValueOnce(new Error("unavailable"));
	h.show();
	fireEvent.click(
		await screen.findByRole("button", { name: "通知センター、2件" }),
	);
	fireEvent.click(screen.getByRole("button", { name: "履歴をクリア" }));
	await screen.findByText(
		"一部の通知履歴をクリアできませんでした。もう一度試してください。",
	);
	await waitFor(() => expect(screen.queryByText("仕事完了")).toBeNull());
	expect(screen.queryByText("タイマー終了")).toBeNull();
	expect(screen.getByText("ボード完了")).toBeTruthy();
	await waitFor(() =>
		expect(
			(
				screen.getByRole("button", {
					name: "履歴をクリア",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false),
	);
	fireEvent.click(screen.getByRole("button", { name: "履歴をクリア" }));
	await screen.findByText("通知はありません");
	expect(
		screen.queryByText(
			"一部の通知履歴をクリアできませんでした。もう一度試してください。",
		),
	).toBeNull();
});
