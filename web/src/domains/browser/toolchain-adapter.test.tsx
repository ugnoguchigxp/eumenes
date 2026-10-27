import type { BrowserWorkspaceResource } from "@eumenes/artifact-ui/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "../../../../client/transport";
import type { AdapterHostContext } from "../toolchain-artifacts/registry";

const api = vi.hoisted(() => ({
	tasks: vi.fn(async () => [] as unknown[]),
	bridge: vi.fn(async () => ({
		revision: 0,
		enabled: false,
		configured: false,
		available: true,
	})),
	saveBridge: vi.fn(async () => undefined),
	setting: vi.fn(async () => ({
		executablePath: "/Applications/Brave/brave",
		suggestedPath: "",
		canBrowse: true,
	})),
	saveSetting: vi.fn(async (path: string) => path),
	browse: vi.fn(async (): Promise<string | null> => null),
	tabs: vi.fn(async () => [] as unknown[]),
	histories: vi.fn(async () => [] as unknown[]),
	history: vi.fn(async (_id: string, _signal?: AbortSignal) => ({}) as unknown),
}));
vi.mock("./api", () => ({ browserApiFor: () => api }));

import { BROWSER_ADAPTER_REF, browserWebAdapter } from "./toolchain-adapter";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.useRealTimers();
	document.body.innerHTML = "";
});

const connection = (state: string, over: Record<string, unknown> = {}) => ({
	state,
	endReason: null,
	configured: true,
	availability:
		state === "connected"
			? { available: true }
			: { available: false, reason: "browser_disconnected" },
	...over,
});
const sourceOf = (state: string, over: Record<string, unknown> = {}) => ({
	revision: 4,
	data: {
		connection: connection(state),
		tabs: [
			{
				tabRef: "t1",
				title: "Eumenes",
				url: "http://127.0.0.1:5173/",
				active: true,
				status: "idle",
			},
		],
		tasks: [],
		captures: [],
		...over,
	},
});

function setup(read: () => Promise<unknown>, visible = true) {
	const client = {
		identity: crypto.randomUUID(),
		toolchainArtifactSource: vi.fn(read),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const context = {
		client,
		artifactRevisionId: "artifact:browser.workspace@1",
		visible,
	} as unknown as AdapterHostContext;
	const hook = renderHook(() => browserWebAdapter.useArtifact(context), {
		wrapper: ({ children }: PropsWithChildren) => (
			<QueryClientProvider client={cache}>{children}</QueryClientProvider>
		),
	});
	return { client, hook, cache };
}
const event = (
	action: string,
	values: Record<string, string | boolean> = {},
) => ({
	id: "e1",
	source: "browser",
	revision: 0,
	action: action as never,
	values,
});

test("is registered for the browser adapter and serves the browser snapshot", async () => {
	const { hook, client } = setup(async () => sourceOf("disconnected"));
	expect(browserWebAdapter.adapterRef).toBe(BROWSER_ADAPTER_REF);
	expect(BROWSER_ADAPTER_REF).toBe("adapter:browser@1");
	expect(hook.result.current.phase.kind).toBe("loading");
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	expect(client.toolchainArtifactSource).toHaveBeenCalledWith(
		"artifact:browser.workspace@1",
		"browser",
		undefined,
		expect.anything(),
	);
	await waitFor(() =>
		expect(hook.result.current.snapshot.browser).toMatchObject({
			kind: "browser",
			connection: { state: "disconnected" },
			executablePath: "/Applications/Brave/brave",
		}),
	);
	expect(hook.result.current.targetOf("browser")).toBeUndefined();
});

test("reads the tabs from Brave again only while connected", async () => {
	const idle = setup(async () => sourceOf("disconnected"));
	await waitFor(() =>
		expect(idle.hook.result.current.phase.kind).toBe("ready"),
	);
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(api.tabs).not.toHaveBeenCalled();
	cleanup();
	api.tabs.mockResolvedValue([
		{
			tabRef: "fresh",
			title: "Opened",
			url: "https://example.com/",
			active: false,
			status: "idle",
		},
	]);
	const live = setup(async () => sourceOf("connected"));
	await waitFor(() =>
		expect(
			(
				live.hook.result.current.snapshot.browser as unknown as {
					tabs: Array<{ tabRef: string }>;
				}
			).tabs.map((t) => t.tabRef),
		).toEqual(["fresh"]),
	);
});

test("saving the path goes to the browser API and the source is read again", async () => {
	const { hook, client } = setup(async () => sourceOf("disconnected"));
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	const before = client.toolchainArtifactSource.mock.calls.length;
	const saved = await hook.result.current.local(
		{} as never,
		event("browser-save-path", { path: "/Applications/Brave/brave2" }),
	);
	expect(saved).toMatchObject({ status: "accepted" });
	expect(api.saveSetting).toHaveBeenCalledWith("/Applications/Brave/brave2");
	await waitFor(() =>
		expect(client.toolchainArtifactSource.mock.calls.length).toBeGreaterThan(
			before,
		),
	);
});

test("a file chosen in the OS dialog fills the field unsaved; a cancelled dialog says nothing", async () => {
	const { hook } = setup(async () => sourceOf("disconnected"));
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	const shown = () =>
		hook.result.current.snapshot.browser as unknown as {
			pickedExecutable?: { path: string; pickId: number };
			canBrowseExecutable: boolean;
		};
	await waitFor(() => expect(shown().canBrowseExecutable).toBe(true));
	expect(
		await hook.result.current.local({} as never, event("browser-browse-path")),
	).toEqual({ status: "accepted", message: "" });
	api.browse.mockResolvedValueOnce("/Applications/Brave/brave3");
	expect(
		await hook.result.current.local({} as never, event("browser-browse-path")),
	).toMatchObject({
		status: "accepted",
		message: expect.stringContaining("保存"),
	});
	await waitFor(() =>
		expect(shown().pickedExecutable?.path).toBe("/Applications/Brave/brave3"),
	);
	expect(api.saveSetting).not.toHaveBeenCalled();
	api.browse.mockRejectedValueOnce(new ApiError(409, "browser_browse_busy"));
	expect(
		await hook.result.current.local({} as never, event("browser-browse-path")),
	).toMatchObject({
		status: "rejected",
		message: expect.stringContaining("すでに開いています"),
	});
});

test("a path the backend refuses is explained, and other events are not local", async () => {
	const { hook } = setup(async () => sourceOf("disconnected"));
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	api.saveSetting.mockRejectedValueOnce(
		new ApiError(400, "invalid_browser_setting"),
	);
	expect(
		await hook.result.current.local(
			{} as never,
			event("browser-save-path", { path: "relative/brave" }),
		),
	).toMatchObject({
		status: "rejected",
		message: expect.stringContaining("絶対パス"),
	});
	// A path that is no executable file gets its own explanation.
	api.saveSetting.mockRejectedValueOnce(
		new ApiError(400, "browser_executable_invalid"),
	);
	expect(
		await hook.result.current.local(
			{} as never,
			event("browser-save-path", { path: "/no/such/brave" }),
		),
	).toMatchObject({
		status: "rejected",
		message: expect.stringContaining("実行できるファイルが見つかりません"),
	});
	expect(
		await hook.result.current.local({} as never, event("browser-connect", {})),
	).toMatchObject({ status: "rejected" });
	expect(
		await hook.result.current.local({} as never, {
			...event("browser-save-path", { path: "/x" }),
			source: "other",
		}),
	).toMatchObject({ status: "rejected" });
});

test("an unreadable source is shown as an error", async () => {
	const { hook } = setup(async () => {
		throw new Error("source_failed");
	});
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("error"));
});

test("domain refusals are worded for the screen and others fall back to the host", async () => {
	const { hook } = setup(async () => sourceOf("disconnected"));
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	const describe = hook.result.current.describeRejection!;
	expect(describe("browser_not_configured", [])).toContain("パス");
	expect(describe("tab_lost", [])).toContain("タブ");
	expect(describe("tab_blocked", [])).toContain("開けないページ");
	expect(describe("something_else", [])).toBeUndefined();
	expect(describe(undefined, [])).toBeUndefined();
});

test("Bridge credentials use the local settings route and never enter the resource or source request", async () => {
	const { hook, client } = setup(async () => sourceOf("disconnected"));
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	await hook.result.current.local(
		{} as never,
		event("browser-bridge-save", {
			token: "fixture-private-token",
			enabled: true,
			clear: false,
			expectedRevision: "0",
		}),
	);
	expect(api.saveBridge).toHaveBeenCalledWith({
		token: "fixture-private-token",
		enabled: true,
		clear: false,
		expectedRevision: 0,
	});
	expect(JSON.stringify(hook.result.current.snapshot)).not.toContain(
		"fixture-private-token",
	);
	expect(
		JSON.stringify(client.toolchainArtifactSource.mock.calls),
	).not.toContain("fixture-private-token");
});

test("reconnecting fetches the new session tabs instead of reusing the previous session cache", async () => {
	let id = "old-connection";
	api.tabs
		.mockResolvedValueOnce([
			{
				tabRef: "old",
				title: "Old",
				url: "https://example.com/old",
				status: "idle",
				active: true,
			},
		])
		.mockResolvedValueOnce([
			{
				tabRef: "new",
				title: "New",
				url: "https://example.com/new",
				status: "idle",
				active: true,
			},
		]);
	const { hook, cache } = setup(async () =>
		sourceOf("connected", {
			connection: connection("connected", { connectionId: id }),
		}),
	);
	await waitFor(() =>
		expect(
			(hook.result.current.snapshot.browser as BrowserWorkspaceResource).tabs[0]
				?.tabRef,
		).toBe("old"),
	);
	id = "new-connection";
	await cache.invalidateQueries({
		predicate: (q) => q.queryKey.includes("source"),
	});
	await waitFor(() =>
		expect(
			(hook.result.current.snapshot.browser as BrowserWorkspaceResource).tabs[0]
				?.tabRef,
		).toBe("new"),
	);
});

test("loads current-chat history independently of the global twenty-task source window", async () => {
	const own = {
		taskId: "own",
		conversationId: "main",
		requestSummary: "この会話の依頼",
		state: "running",
		phase: "thinking",
	};
	api.tasks.mockResolvedValueOnce([own]);
	const others = Array.from({ length: 20 }, (_, i) => ({
		taskId: `other-${i}`,
		conversationId: "another",
		requestSummary: "別会話",
		state: "completed",
	}));
	const { hook } = setup(async () => sourceOf("connected", { tasks: others }));
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	expect(
		(hook.result.current.snapshot.browser as BrowserWorkspaceResource).tasks,
	).toMatchObject([own]);
	expect(api.tasks).toHaveBeenCalledWith("main", expect.any(AbortSignal));
});

const capture = (captureId: string) => ({
	captureId,
	range: "full-page",
	capturedAt: "2026-10-25T01:00:00.000Z",
	width: 800,
	height: 600,
	bytes: 1000,
	reductionPercent: 50,
	state: "local_ready",
});

/** The capture row the workspace draws on its captures view. */
function drawCapture(captureId: string, selected = false) {
	const root = document.createElement("section");
	root.className = "browser-workspace";
	const item = document.createElement("li");
	item.setAttribute("data-capture-id", captureId);
	if (selected) item.setAttribute("data-selected", "true");
	item.scrollIntoView = vi.fn();
	root.append(item);
	document.body.append(root);
	return item;
}

test("focus asks the screen to show the capture, marks its row for two seconds and viewing names the selected one", async () => {
	const { hook, cache } = setup(async () =>
		sourceOf("connected", { captures: [capture("c1"), capture("c2")] }),
	);
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	expect(hook.result.current.snapshot.browser).not.toHaveProperty("focus");
	const row = drawCapture("c2", true);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	let done: Promise<boolean> | undefined;
	await act(async () => {
		done = browserWebAdapter.focus?.("c2");
		await vi.advanceTimersByTimeAsync(200);
	});
	await expect(done).resolves.toBe(true);
	expect(hook.result.current.snapshot.browser).toMatchObject({
		focus: { seq: 1, captureId: "c2" },
	});
	expect(row.getAttribute("data-resource-focus")).toBe("true");
	expect(browserWebAdapter.viewing?.()).toBe("eumenes://capture/c2");
	await vi.advanceTimersByTimeAsync(2_010);
	expect(row.hasAttribute("data-resource-focus")).toBe(false);
	cache.clear();
});

test("focus says no to a capture the screen lacks, and viewing is null without a selected capture", async () => {
	const { hook, cache } = setup(async () =>
		sourceOf("connected", { captures: [capture("c1")] }),
	);
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	drawCapture("c1");
	expect(browserWebAdapter.viewing?.()).toBeNull();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const unknown = browserWebAdapter.focus?.("missing");
	await vi.advanceTimersByTimeAsync(5_500);
	await expect(unknown).resolves.toBe(false);
	expect(hook.result.current.snapshot.browser).not.toHaveProperty("focus");
	cache.clear();
});

const summary = (historyId: string, over: Record<string, unknown> = {}) => ({
	historyId,
	revision: 2,
	title: `手続き ${historyId}`,
	request: "依頼",
	place: "example.com",
	variables: [],
	stepCount: 1,
	runCount: 1,
	failureCount: 0,
	lastOutcome: "completed",
	hasCommit: false,
	lastUsedAt: 2,
	createdAt: 1,
	updatedAt: 2,
	...over,
});
const detailOf = (historyId: string) => ({
	...summary(historyId),
	steps: [],
	actions: [],
	source: "test('x', async () => {});",
});
const shown = (hook: ReturnType<typeof setup>["hook"]) =>
	hook.result.current.snapshot.browser as BrowserWorkspaceResource;

test("the history list is read only while the screen is shown", async () => {
	api.histories.mockResolvedValue([summary("h1")]);
	const hidden = setup(async () => sourceOf("disconnected"), false);
	await waitFor(() =>
		expect(hidden.hook.result.current.phase.kind).toBe("ready"),
	);
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(api.histories).not.toHaveBeenCalled();
	cleanup();
	const live = setup(async () => sourceOf("disconnected"));
	await waitFor(() =>
		expect(shown(live.hook).histories.map((h) => h.historyId)).toEqual(["h1"]),
	);
});

test("opening a history reads its detail, closing drops the selection and a delete closes it and reads the list again", async () => {
	api.histories.mockResolvedValue([summary("h1")]);
	api.history.mockResolvedValue(detailOf("h1"));
	const { hook } = setup(async () => sourceOf("disconnected"));
	await waitFor(() => expect(shown(hook).histories).toHaveLength(1));
	expect(api.history).not.toHaveBeenCalled();
	const open = hook.result.current.sourceRead?.(
		event("browser-select-history", { historyId: "h1" }),
	);
	await act(async () => {
		await open;
	});
	await waitFor(() => expect(shown(hook).historyDetail?.source).toBeTruthy());
	expect(shown(hook).selectedHistoryId).toBe("h1");
	expect(api.history).toHaveBeenCalledWith("h1", expect.any(AbortSignal));
	const listReads = api.histories.mock.calls.length;
	api.histories.mockResolvedValue([]);
	await act(async () => {
		hook.result.current.settled(
			{ eventAction: "browser-delete-history" } as never,
			{ receipt: {} } as never,
			{ sent: 0, sentAt: 0 },
			{ historyId: "h1", expectedRevision: 2 },
		);
	});
	await waitFor(() => expect(shown(hook).selectedHistoryId).toBeUndefined());
	await waitFor(() => expect(shown(hook).histories).toEqual([]));
	expect(api.histories.mock.calls.length).toBeGreaterThan(listReads);
	expect(shown(hook).historyDetail).toBeUndefined();
	// Closing is a read too.
	await act(async () => {
		await hook.result.current.sourceRead?.(
			event("browser-select-history", { historyId: "h1" }),
		);
	});
	await act(async () => {
		await hook.result.current.sourceRead?.(
			event("browser-select-history", { historyId: "" }),
		);
	});
	await waitFor(() => expect(shown(hook).selectedHistoryId).toBeUndefined());
});

test("only the select-history read is answered by the source; a bad id is refused", async () => {
	const { hook } = setup(async () => sourceOf("disconnected"));
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	expect(hook.result.current.sourceRead?.(event("browser-connect"))).toBeNull();
	await expect(
		hook.result.current.sourceRead?.(
			event("browser-select-history", { historyId: "../x" }),
		),
	).resolves.toMatchObject({ status: "rejected" });
	expect(shown(hook).selectedHistoryId).toBeUndefined();
});

test("a detail that is gone or unreadable is explained in the modal", async () => {
	api.histories.mockResolvedValue([summary("h1")]);
	api.history.mockRejectedValue(new ApiError(404, "browser_history_not_found"));
	const { hook } = setup(async () => sourceOf("disconnected"));
	await act(async () => {
		await hook.result.current.sourceRead?.(
			event("browser-select-history", { historyId: "h1" }),
		);
	});
	await waitFor(() =>
		expect(shown(hook).historyDetailError).toBe(
			"この履歴は見つかりません。削除された可能性があります。",
		),
	);
	expect(api.history).toHaveBeenCalledTimes(1);
});

test("the list is read again when a task reaches an ended state, not on the first read", async () => {
	api.histories.mockResolvedValue([]);
	const task = (state: string) => ({
		taskId: "k1",
		requestSummary: "依頼",
		state,
	});
	let state = "running";
	const { hook, cache } = setup(async () =>
		sourceOf("disconnected", { tasks: [task(state)] }),
	);
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	await waitFor(() => expect(api.histories).toHaveBeenCalledTimes(1));
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(api.histories).toHaveBeenCalledTimes(1);
	state = "completed";
	api.tasks.mockResolvedValue([task("completed")]);
	await cache.invalidateQueries({
		predicate: (q) => q.queryKey.includes("source"),
	});
	await waitFor(() => expect(api.histories).toHaveBeenCalledTimes(2));
});

test("history refusals are worded and re-read the list and the open detail without resending", async () => {
	api.histories.mockResolvedValue([summary("h1")]);
	api.history.mockResolvedValue(detailOf("h1"));
	const { hook } = setup(async () => sourceOf("disconnected"));
	await act(async () => {
		await hook.result.current.sourceRead?.(
			event("browser-select-history", { historyId: "h1" }),
		);
	});
	await waitFor(() => expect(shown(hook).historyDetail).toBeDefined());
	const lists = api.histories.mock.calls.length;
	const details = api.history.mock.calls.length;
	expect(
		hook.result.current.describeRejection?.("browser_history_conflict", []),
	).toBe(
		"履歴が更新されていました。最新の内容を読み直しました。確認してからもう一度削除してください。",
	);
	await waitFor(() => {
		expect(api.histories.mock.calls.length).toBeGreaterThan(lists);
		expect(api.history.mock.calls.length).toBeGreaterThan(details);
	});
	expect(
		hook.result.current.describeRejection?.("browser_history_not_found", []),
	).toBe(
		"その履歴は見つかりません。削除された可能性があります。一覧を読み直しました。",
	);
});

const replayOf = (state: string, over: Record<string, unknown> = {}) => ({
	replayId: "r1",
	historyId: "h1",
	state,
	errorCode: null,
	errorLabel: null,
	startedAt: 1,
	endedAt: state === "running" ? null : 2,
	...over,
});

test("a replay that ends reads the history list again; a running one does not", async () => {
	let replays = [replayOf("running")];
	api.histories.mockResolvedValue([summary("h1")]);
	const { hook, cache } = setup(async () =>
		sourceOf("disconnected", { replays }),
	);
	await waitFor(() =>
		expect(shown(hook).replays.map((r) => r.state)).toEqual(["running"]),
	);
	await waitFor(() => expect(api.histories).toHaveBeenCalledTimes(1));
	await cache.invalidateQueries({
		predicate: (q) => q.queryKey.includes("source"),
	});
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(api.histories).toHaveBeenCalledTimes(1);
	replays = [replayOf("completed")];
	await cache.invalidateQueries({
		predicate: (q) => q.queryKey.includes("source"),
	});
	await waitFor(() => expect(api.histories).toHaveBeenCalledTimes(2));
	expect(shown(hook).replays.map((r) => r.state)).toEqual(["completed"]);
	// Reading an already ended replay again is not a new end.
	await cache.invalidateQueries({
		predicate: (q) => q.queryKey.includes("source"),
	});
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(api.histories).toHaveBeenCalledTimes(2);
});

test("replay refusals are worded and re-read the screen without resending", async () => {
	api.histories.mockResolvedValue([summary("h1")]);
	const { hook, client } = setup(async () => sourceOf("disconnected"));
	await waitFor(() => expect(hook.result.current.phase.kind).toBe("ready"));
	const words: Record<string, string> = {
		replay_busy: "別のリプレイまたはブラウザ操作を実行中です。",
		replay_values_invalid: "変数の値を確かめてください。",
		replay_incomplete: "記録されていない操作や値があるため実行できません。",
		replay_code_rejected: "このコードは安全のため実行できません。",
		replay_destination_blocked: "開けない移動先が含まれています。",
	};
	for (const [code, text] of Object.entries(words)) {
		const reads = client.toolchainArtifactSource.mock.calls.length;
		expect(hook.result.current.describeRejection?.(code, [])).toBe(text);
		await waitFor(() =>
			expect(client.toolchainArtifactSource.mock.calls.length).toBeGreaterThan(
				reads,
			),
		);
	}
	for (const code of ["browser_replay_not_found", "replay_not_running"]) {
		const reads = client.toolchainArtifactSource.mock.calls.length;
		expect(hook.result.current.describeRejection?.(code, [])).toBeTruthy();
		await waitFor(() =>
			expect(client.toolchainArtifactSource.mock.calls.length).toBeGreaterThan(
				reads,
			),
		);
	}
});
