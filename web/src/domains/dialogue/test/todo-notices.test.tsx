import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, test, vi } from "vitest";
import type { TodoNotice } from "../../../../../api/domains/dialogue/contracts";
import { queryRoots } from "../../../queryKeys";
import { useTodoNotices } from "../hooks/todo-notices";

const notice = (id: string, read = false): TodoNotice => ({
	id,
	conversationId: "main",
	title: `仕事 ${id}`,
	outcome: "succeeded",
	summary: null,
	links: [],
	read,
	createdAt: "2026-10-29T11:00:00.000Z",
});

function setup(initial: TodoNotice[]) {
	let notices = initial;
	const client = {
		identity: "todo-fixture",
		todoNotices: vi.fn(async () => ({
			notices,
			unread: notices.filter((n) => !n.read).length,
		})),
		readTodoNotice: vi.fn(async (id: string): Promise<void> => {
			notices = notices.map((n) => (n.id === id ? { ...n, read: true } : n));
		}),
	};
	const cache = new QueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	const chime = vi.fn();
	const hook = renderHook(() => useTodoNotices(client, chime), { wrapper });
	// A server change refreshes the dialogue's views, the notices among them.
	const change = async (next: TodoNotice[]) => {
		notices = next;
		const calls = client.todoNotices.mock.calls.length;
		await act(async () => {
			await cache.invalidateQueries({ queryKey: [queryRoots.dialogue] });
		});
		await waitFor(() =>
			expect(client.todoNotices).toHaveBeenCalledTimes(calls + 1),
		);
	};
	const setNotices = (next: (all: TodoNotice[]) => TodoNotice[]) => {
		notices = next(notices);
	};
	return { client, chime, hook, change, setNotices };
}

test("notices present at the first load do not sound; each newly finished TODO sounds once", async () => {
	const h = setup([notice("a")]);
	await waitFor(() => expect(h.hook.result.current.notices).toHaveLength(1));
	expect(h.hook.result.current.unread).toBe(1);
	expect(h.chime).not.toHaveBeenCalled();
	await h.change([notice("b"), notice("a")]);
	await waitFor(() => expect(h.chime).toHaveBeenCalledOnce());
	await h.change([notice("b"), notice("a")]);
	expect(h.chime).toHaveBeenCalledOnce();
	// One read elsewhere before this page saw it stays silent.
	await h.change([notice("c", true), notice("b"), notice("a")]);
	expect(h.chime).toHaveBeenCalledOnce();
});

test("a pressed notice hides at once, before the server answers, and stays read once it does", async () => {
	const h = setup([notice("a"), notice("b")]);
	await waitFor(() => expect(h.hook.result.current.notices).toHaveLength(2));
	let answer!: () => void;
	h.client.readTodoNotice.mockImplementationOnce(
		(id: string) =>
			new Promise<void>((resolve) => {
				answer = () => {
					h.setNotices((all) =>
						all.map((n) => (n.id === id ? { ...n, read: true } : n)),
					);
					resolve();
				};
			}),
	);
	let reading!: Promise<void>;
	act(() => {
		reading = h.hook.result.current.onRead(h.hook.result.current.notices[0]!);
	});
	await waitFor(() =>
		expect(h.hook.result.current.notices[0]?.read).toBe(true),
	);
	expect(h.hook.result.current.unread).toBe(1);
	await act(async () => {
		answer();
		await reading;
	});
	expect(h.client.readTodoNotice).toHaveBeenCalledWith("a");
	expect(h.hook.result.current.notices[0]?.read).toBe(true);
	expect(h.hook.result.current.unread).toBe(1);
});

test("a read that fails brings the notice back and reports it", async () => {
	const h = setup([notice("a")]);
	await waitFor(() => expect(h.hook.result.current.notices).toHaveLength(1));
	h.client.readTodoNotice.mockRejectedValueOnce(new Error("boom"));
	await act(async () => {
		await h.hook.result.current.onRead(h.hook.result.current.notices[0]!);
	});
	expect(h.hook.result.current.error).toContain("既読にできませんでした");
	await waitFor(() =>
		expect(h.hook.result.current.notices[0]?.read).toBe(false),
	);
	expect(h.hook.result.current.unread).toBe(1);
});
