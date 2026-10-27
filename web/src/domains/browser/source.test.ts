import { expect, it } from "vitest";
import { browserSourceData } from "./contracts";
import { browserResource } from "./source";

const connection = (over: Record<string, unknown> = {}) => ({
	state: "connected",
	endReason: null,
	configured: true,
	availability: { available: true },
	...over,
});
const tab = (over: Record<string, unknown> = {}) => ({
	tabRef: "t1",
	title: "Eumenes",
	url: "http://127.0.0.1:5173/",
	active: true,
	status: "idle",
	...over,
});
const data = (over: Record<string, unknown> = {}) =>
	browserSourceData.parse({
		connection: connection(),
		tabs: [tab()],
		tasks: [],
		captures: [],
		...over,
	});
const resourceOf = (
	value: ReturnType<typeof data> | undefined,
	over: Partial<Parameters<typeof browserResource>[0]> = {},
) =>
	browserResource({
		data: value,
		tabs: undefined,
		executablePath: "/Brave",
		suggestedExecutablePath: undefined,
		loading: false,
		error: undefined,
		...over,
	});

it("maps the connected source and hides closed tabs", () => {
	const resource = resourceOf(
		data({
			tabs: [
				tab(),
				tab({ tabRef: "t2", status: "closed" }),
				tab({ tabRef: "t3", status: "busy", currentTaskLabel: "撮影中" }),
				tab({ tabRef: "t4", status: "blocked" }),
			],
		}),
	);
	expect(resource).toMatchObject({
		kind: "browser",
		availability: { available: true },
		connection: { state: "connected" },
		executablePath: "/Brave",
		suggestedExecutablePath: undefined,
	});
	expect(resource.tabs.map((t) => [t.tabRef, t.status])).toEqual([
		["t1", "open"],
		["t3", "busy"],
		["t4", "blocked"],
	]);
	expect(resource.tabs[1]?.currentTaskLabel).toBe("撮影中");
});

it("uses the freshly read tab list over the source's when one is given", () => {
	const resource = resourceOf(data(), {
		tabs: [
			{
				tabRef: "fresh",
				title: "",
				url: "https://example.com/",
				active: false,
				status: "idle",
			},
		],
	});
	expect(resource.tabs.map((t) => t.tabRef)).toEqual(["fresh"]);
});

it("words the end of a connection in the screen part's codes", () => {
	const ended = (endReason: string, state = "disconnected") =>
		resourceOf(
			data({
				connection: connection({
					state,
					endReason,
					availability: { available: false, reason: "browser_disconnected" },
				}),
			}),
		).connection;
	expect(ended("user")).toEqual({
		state: "disconnected",
		endReason: "user_disconnected",
	});
	expect(ended("backend_restart").endReason).toBe("backend_stopped");
	expect(ended("browser_closed").endReason).toBe("browser_closed");
	expect(ended("connect_timeout", "failed")).toEqual({
		state: "disconnected",
		endReason: "connect_timeout",
	});
	expect(ended("user", "connected").endReason).toBeUndefined();
});

it("keeps the screen usable while Brave waits for the user, and explains other reasons", () => {
	const connecting = resourceOf(
		data({
			connection: connection({
				state: "connecting",
				availability: { available: false, reason: "browser_connecting" },
			}),
		}),
	);
	expect(connecting.availability).toEqual({ available: true });
	expect(connecting.connection.state).toBe("connecting");
	const unset = resourceOf(
		data({
			connection: connection({
				state: "disconnected",
				configured: false,
				availability: { available: false, reason: "browser_not_configured" },
			}),
		}),
	);
	expect(unset.availability).toEqual({
		available: false,
		reason: "browser_not_configured",
	});
});

it("shows nothing but a disconnected, loading screen before the first read", () => {
	const resource = resourceOf(undefined, {
		loading: true,
		executablePath: undefined,
	});
	expect(resource).toMatchObject({
		connection: { state: "disconnected" },
		tabs: [],
		captures: [],
		loading: true,
	});
});

it("changes its revision whenever what is shown changes", () => {
	const a = resourceOf(data());
	const b = resourceOf(data({ tabs: [tab({ title: "other" })] }));
	const c = resourceOf(data());
	expect(a.revision).not.toBe(b.revision);
	expect(a.revision).toBe(c.revision);
});

it("carries captures and tasks through as the screen part's items", () => {
	const resource = resourceOf(
		data({
			captures: [
				{
					captureId: "c1",
					range: "full-page",
					capturedAt: "2026-10-18T09:00:00.000Z",
					width: 1200,
					height: 3000,
					bytes: 52000,
					reductionPercent: 86,
					state: "local_ready",
					taskId: null,
				},
			],
			tasks: [{ taskId: "k1", requestSummary: "開く", state: "running" }],
		}),
	);
	expect(resource.captures).toEqual([
		{
			captureId: "c1",
			range: "full-page",
			capturedAt: "2026-10-18T09:00:00.000Z",
			width: 1200,
			height: 3000,
			bytes: 52000,
			reductionPercent: 86,
			state: "local_ready",
		},
	]);
	expect(resource.tasks).toEqual([
		{ taskId: "k1", requestSummary: "開く", state: "running" },
	]);
});

it("keeps Script progress and errors for the current conversation only", () => {
	const script = {
		revision: 1,
		summary: "表示を確認します",
		updatedAt: 1,
		history: [],
		steps: [
			{
				stepId: "step",
				label: "表示確認",
				expectation: "対象が見える",
				state: "running",
			},
		],
	};
	const tasks = [
		{
			taskId: "own",
			conversationId: "current",
			requestSummary: "依頼",
			state: "failed",
			script,
			errorLabel: "中断されました",
		},
		{
			taskId: "other",
			conversationId: "another",
			requestSummary: "別の依頼",
			state: "running",
		},
	];
	const r = resourceOf(data({ tasks }), { conversationId: "current" });
	expect(r.tasks).toHaveLength(1);
	expect(r.tasks[0]).toMatchObject({
		taskId: "own",
		script,
		errorLabel: "中断されました",
	});
});

it("passes the histories, the open detail and each task's history and script variables to the screen", () => {
	const summary = {
		historyId: "h1",
		revision: 2,
		title: "YouTubeで検索する",
		request: "{{keyword}}を見て",
		place: "www.youtube.com",
		variables: [{ name: "keyword", label: "検索語" }],
		stepCount: 1,
		runCount: 1,
		failureCount: 0,
		lastOutcome: "completed" as const,
		hasCommit: false,
		lastUsedAt: 2,
		createdAt: 1,
		updatedAt: 2,
	};
	const script = {
		revision: 1,
		title: "YouTubeで検索する",
		historyId: "h1",
		variables: [{ name: "keyword", label: "検索語", value: "猫 癒し" }],
		summary: "検索します",
		updatedAt: 1,
		steps: [],
		history: [],
	};
	const resource = resourceOf(
		data({
			tasks: [
				{
					taskId: "k1",
					requestSummary: "動画",
					state: "running",
					history: { historyId: "h1", title: "YouTubeで検索する" },
					script,
				},
			],
		}),
		{ histories: [summary], selectedHistoryId: "h1", historyDetailError: "x" },
	);
	expect(resource.histories).toEqual([summary]);
	expect(resource.selectedHistoryId).toBe("h1");
	expect(resource.historyDetailError).toBe("x");
	expect(resource.tasks[0]?.history).toEqual({
		historyId: "h1",
		title: "YouTubeで検索する",
	});
	expect(resource.tasks[0]?.script?.variables).toEqual(script.variables);
	expect(resourceOf(data()).histories).toEqual([]);
	// The revision follows what the screen shows, so an opened modal changes it.
	expect(resourceOf(data(), { selectedHistoryId: "h1" }).revision).not.toBe(
		resourceOf(data()).revision,
	);
});

it("passes the replays to the screen, leaving out the absent label and end time", () => {
	const resource = resourceOf(
		data({
			replays: [
				{
					replayId: "r2",
					historyId: "h1",
					state: "running",
					errorCode: null,
					errorLabel: null,
					startedAt: 20,
					endedAt: null,
				},
				{
					replayId: "r1",
					historyId: "h1",
					state: "failed",
					errorCode: "replay_failed",
					errorLabel: "実行中にエラーが起きました",
					startedAt: 10,
					endedAt: 15,
				},
			],
		}),
	);
	expect(resource.replays).toEqual([
		{ replayId: "r2", historyId: "h1", state: "running", startedAt: 20 },
		{
			replayId: "r1",
			historyId: "h1",
			state: "failed",
			errorLabel: "実行中にエラーが起きました",
			startedAt: 10,
			endedAt: 15,
		},
	]);
	expect(resourceOf(data()).replays).toEqual([]);
	expect(resourceOf(undefined).replays).toEqual([]);
});

it("changes its revision when a replay changes state", () => {
	const running = {
		replayId: "r1",
		historyId: "h1",
		state: "running",
		errorCode: null,
		errorLabel: null,
		startedAt: 1,
		endedAt: null,
	};
	const a = resourceOf(data({ replays: [running] }));
	const b = resourceOf(
		data({ replays: [{ ...running, state: "completed", endedAt: 2 }] }),
	);
	expect(a.revision).not.toBe(b.revision);
});
