import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, test, vi } from "vitest";
import type { KanbanNoticeView } from "../../../../api/domains/kanban/contracts";
import { queryRoots } from "../../queryKeys";
import { useKanbanNotices } from "./useKanbanNotices";

const notice = (id: string, read = false): KanbanNoticeView => ({
	id,
	kind: "done",
	cardId: "c1",
	runId: "r1",
	text: `タスク『${id}』が終わりました`,
	read,
	createdAt: "2026-10-14T11:00:00.000Z",
});

function setup(initial: KanbanNoticeView[]) {
	let notices = initial;
	const client = {
		identity: "kanban-fixture",
		kanbanNotices: vi.fn(async () => ({
			notices,
			unread: notices.filter((n) => !n.read).length,
		})),
		readKanbanNotice: vi.fn(async (id: string) => {
			notices = notices.map((n) => (n.id === id ? { ...n, read: true } : n));
		}),
	};
	const cache = new QueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	const chime = vi.fn();
	const openById = vi.fn(async () => true);
	const hook = renderHook(() => useKanbanNotices(client, chime, openById), {
		wrapper,
	});
	const change = async (next: KanbanNoticeView[]) => {
		notices = next;
		const calls = client.kanbanNotices.mock.calls.length;
		await act(async () => {
			await cache.invalidateQueries({ queryKey: [queryRoots.kanban] });
		});
		await waitFor(() =>
			expect(client.kanbanNotices).toHaveBeenCalledTimes(calls + 1),
		);
	};
	return { client, chime, openById, hook, change };
}

test("notices present at the first load do not sound; each new unread one sounds once", async () => {
	const h = setup([notice("a")]);
	await waitFor(() => expect(h.hook.result.current.notices).toHaveLength(1));
	expect(h.hook.result.current.unread).toBe(1);
	expect(h.chime).not.toHaveBeenCalled();
	await h.change([notice("a")]);
	expect(h.chime).not.toHaveBeenCalled();
	await h.change([notice("b"), notice("a")]);
	await waitFor(() => expect(h.chime).toHaveBeenCalledOnce());
	await h.change([notice("b"), notice("a")]);
	expect(h.chime).toHaveBeenCalledOnce();
	// A notice that was read elsewhere before this page saw it stays silent.
	await h.change([notice("c", true), notice("b"), notice("a")]);
	expect(h.chime).toHaveBeenCalledOnce();
});

test("marking a notice read calls the API and reloads the list", async () => {
	const h = setup([notice("a")]);
	await waitFor(() => expect(h.hook.result.current.notices).toHaveLength(1));
	await act(async () => {
		await h.hook.result.current.onRead(h.hook.result.current.notices[0]!);
	});
	expect(h.client.readKanbanNotice).toHaveBeenCalledWith("a");
	await waitFor(() => expect(h.hook.result.current.unread).toBe(0));
	expect(h.hook.result.current.notices[0]?.read).toBe(true);
	expect(h.chime).not.toHaveBeenCalled();
	expect(h.hook.result.current.readingIds).toEqual([]);
});

test("a failed read reports an error; the board opens by its artifact id", async () => {
	const h = setup([notice("a")]);
	await waitFor(() => expect(h.hook.result.current.notices).toHaveLength(1));
	h.client.readKanbanNotice.mockRejectedValueOnce(new Error("boom"));
	await act(async () => {
		await h.hook.result.current.onRead(h.hook.result.current.notices[0]!);
	});
	expect(h.hook.result.current.error).toContain("既読にできませんでした");
	act(() => h.hook.result.current.onOpenBoard());
	expect(h.openById).toHaveBeenCalledWith("kanban.board");
});

test("only a new done notice requests completion speech; waiting, blockers and git steps do not", async () => {
	const baseline = notice("loaded", true);
	const h = setup([baseline]);
	await waitFor(() => expect(h.hook.result.current.notices).toHaveLength(1));
	const previous: KanbanNoticeView[] = [baseline];
	for (const kind of [
		"waiting",
		"blocker",
		"commit_push",
		"git_completed",
		"queue_paused",
		"stopped",
		"done",
	] as const) {
		previous.unshift({ ...notice(kind), kind });
		await h.change([...previous]);
		await waitFor(() =>
			expect(h.chime).toHaveBeenLastCalledWith(kind === "done", {
				source: "kanban",
				ids: [kind],
			}),
		);
	}
});
