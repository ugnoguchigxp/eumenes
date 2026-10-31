import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { KanbanNoticeView } from "../../../api/domains/kanban/contracts";
import type { TodoNotice } from "../../../api/domains/dialogue/contracts";
import { useTodoNotices } from "../domains/dialogue";
import { useKanbanNotices } from "../domains/kanban/useKanbanNotices";
import { settingsFixture } from "../domains/settings/sections/fixture";
import { queryRoots } from "../queryKeys";
import { useNotificationAudio } from "./useNotificationAudio";

const output = vi.hoisted(() => ({
	startOutput: vi.fn(async () => {}),
	play: vi.fn(async (_bytes, done, options) => {
		options.onStarted();
		done();
	}),
	stopPlayback: vi.fn(),
	stop: vi.fn(async () => {}),
}));
vi.mock("../domains/audio/controller", () => ({
	createAudioController: () => output,
}));
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
const wav = (marker: number) => {
	const bytes = new Uint8Array(46);
	bytes.set(new TextEncoder().encode("RIFF"));
	bytes.set(new TextEncoder().encode("WAVE"), 8);
	bytes[44] = marker;
	return bytes;
};

test("real notice hooks append the saved voice after the tone only for successful work; repeated snapshots and timers do not speak completion", async () => {
	const trace = vi.spyOn(console, "info").mockImplementation(() => {});
	const traces = () => trace.mock.calls.map(([, entry]) => JSON.parse(entry));
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async (url: string) =>
				new Response(wav(url.includes("task-completed") ? 2 : 1)),
		),
	);
	let board: KanbanNoticeView[] = [
		{
			id: "loaded",
			kind: "waiting",
			cardId: "c",
			runId: "r",
			text: "確認",
			read: true,
			createdAt: "2026-10-31T00:00:00Z",
		},
	];
	let todo: TodoNotice[] = [
		{
			id: "loaded",
			conversationId: "main",
			title: "以前",
			outcome: "succeeded",
			summary: null,
			links: [],
			read: true,
			createdAt: "2026-10-31T00:00:00Z",
		},
	];
	const client = {
		identity: "completion-integration",
		kanbanNotices: vi.fn(async () => ({
			notices: board,
			unread: board.filter((n) => !n.read).length,
		})),
		readKanbanNotice: vi.fn(async () => {}),
		todoNotices: vi.fn(async () => ({
			notices: todo,
			unread: todo.filter((n) => !n.read).length,
		})),
		readTodoNotice: vi.fn(async () => {}),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	const settings = settingsFixture().voice;
	settings.notificationSound = "soft-chime";
	settings.completionVoice = "task-completed-ja-male";
	const liveSpeech = vi.fn();
	const hook = renderHook(
		() => {
			const audio = useNotificationAudio(settings, undefined, liveSpeech);
			const kanban = useKanbanNotices(client, audio.chime, async () => true);
			const todos = useTodoNotices(client, audio.chime);
			return { audio, kanban, todos };
		},
		{ wrapper },
	);
	await waitFor(() => {
		expect(hook.result.current.kanban.notices).toHaveLength(1);
		expect(hook.result.current.todos.notices).toHaveLength(1);
	});
	expect(output.play).not.toHaveBeenCalled();
	board = [
		{ ...board[0]!, id: "question", kind: "waiting", read: false },
		...board,
	];
	await act(async () => {
		await cache.invalidateQueries({ queryKey: [queryRoots.kanban] });
	});
	await waitFor(() => expect(output.play).toHaveBeenCalledTimes(1));
	expect(output.play.mock.calls[0]?.[0][44]).toBe(1);
	todo = [{ ...todo[0]!, id: "finished", read: false }, ...todo];
	await act(async () => {
		await cache.invalidateQueries({ queryKey: [queryRoots.dialogue] });
	});
	await waitFor(() => expect(output.play).toHaveBeenCalledTimes(3));
	await waitFor(() => expect(trace).toHaveBeenCalledTimes(6));
	expect(traces().map((entry) => entry.stage)).toEqual([
		"requested",
		"tone.started",
		"tone.ended",
		"completion.started",
		"completion.ended",
		"finished",
	]);
	expect(new Set(traces().map((entry) => entry.playbackId)).size).toBe(1);
	expect(new Set(traces().map((entry) => entry.instanceId)).size).toBe(1);
	expect(Object.keys(traces()[0]).sort()).toEqual([
		"instanceId",
		"noticeIds",
		"noticeSource",
		"playbackId",
		"stage",
	]);
	expect(traces()[0]).toMatchObject({
		noticeSource: "todo",
		noticeIds: ["finished"],
	});
	expect(output.play.mock.calls.map((call) => call[0][44])).toEqual([1, 1, 2]);
	await act(async () => {
		await cache.invalidateQueries({ queryKey: [queryRoots.dialogue] });
	});
	expect(output.play).toHaveBeenCalledTimes(3);
	board = [{ ...board[0]!, id: "done", kind: "done" }, ...board];
	await act(async () => {
		await cache.invalidateQueries({ queryKey: [queryRoots.kanban] });
	});
	await waitFor(() => expect(output.play).toHaveBeenCalledTimes(5));
	await act(async () => {
		await hook.result.current.audio.play(new AbortController().signal);
	});
	expect(output.play.mock.calls.map((call) => call[0][44])).toEqual([
		1, 1, 2, 1, 2, 1,
	]);
	expect(liveSpeech).not.toHaveBeenCalled();
	cache.clear();
});
