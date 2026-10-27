import { expect, it } from "vitest";
import {
	browserHistoryList,
	browserSourceData,
	browserHistoryResult,
	browserTaskList,
} from "./contracts";

const summary = {
	historyId: "h1",
	revision: 3,
	title: "YouTubeで検索し、結果からランダムに再生する",
	request: "おすすめの動画を再生して",
	place: "www.youtube.com",
	variables: [{ name: "keyword", label: "検索語" }],
	stepCount: 2,
	runCount: 3,
	failureCount: 0,
	lastOutcome: "completed",
	hasCommit: false,
	lastUsedAt: 1792454400000,
	createdAt: 1792368000000,
	updatedAt: 1792454400000,
};
const detail = {
	...summary,
	steps: [{ label: "検索する", expectation: "結果が表示される" }],
	actions: [
		{ seq: 1, kind: "navigate", url: "https://www.youtube.com/", place: "x/" },
		{
			seq: 2,
			kind: "type",
			element: "検索ボックス",
			variable: "keyword",
			purpose: "検索語",
			effect: "input",
			code: "await page.fill('x', keyword);",
		},
	],
	source: "test('x', async () => {});",
};

it("reads the history list and the detail with the source", () => {
	expect(browserHistoryList.parse({ histories: [summary] }).histories).toEqual([
		summary,
	]);
	expect(browserHistoryList.parse({ histories: [] }).histories).toEqual([]);
	const parsed = browserHistoryResult.parse({ history: detail }).history;
	expect(parsed.source).toBe(detail.source);
	expect(parsed.actions.map((a) => a.kind)).toEqual(["navigate", "type"]);
});

it("refuses a history of the wrong shape", () => {
	expect(() =>
		browserHistoryList.parse({
			histories: [{ ...summary, lastOutcome: "cancelled" }],
		}),
	).toThrow();
	expect(() =>
		browserHistoryList.parse({ histories: [{ ...summary, title: undefined }] }),
	).toThrow();
	expect(() =>
		browserHistoryResult.parse({
			history: { ...detail, actions: [{ seq: 1, kind: "teleport" }] },
		}),
	).toThrow();
	expect(() =>
		browserHistoryResult.parse({ history: { ...detail, source: undefined } }),
	).toThrow();
});

it("keeps the optional Script title, history and variables and the task's history", () => {
	const script = {
		revision: 1,
		summary: "s",
		updatedAt: 1,
		steps: [],
		history: [],
	};
	const task = {
		taskId: "k1",
		requestSummary: "r",
		state: "running",
		script: {
			...script,
			title: "手続き",
			historyId: "h1",
			variables: [{ name: "keyword", label: "検索語", value: "猫" }],
		},
		history: { historyId: "h1", title: "手続き" },
	};
	const parsed = browserTaskList.parse({
		tasks: [task, { taskId: "k2", requestSummary: "r", state: "completed" }],
	}).tasks;
	expect(parsed[0]?.script?.variables).toEqual(task.script.variables);
	expect(parsed[0]?.script?.historyId).toBe("h1");
	expect(parsed[0]?.history).toEqual(task.history);
	expect(parsed[1]?.history).toBeUndefined();
	expect(() =>
		browserTaskList.parse({
			tasks: [{ ...task, history: { historyId: 1, title: "x" } }],
		}),
	).toThrow();
});

const replay = {
	replayId: "r1",
	historyId: "h1",
	state: "failed",
	errorCode: "replay_timeout",
	errorLabel:
		"時間内に終わりませんでした（要素が見つからない可能性があります）",
	startedAt: 1792454400000,
	endedAt: 1792454460000,
};
const sourceBase = {
	connection: {
		state: "connected",
		endReason: null,
		configured: true,
		availability: { available: true },
	},
	tabs: [],
	tasks: [],
	captures: [],
};

it("reads the source's replays and defaults to none when absent", () => {
	expect(
		browserSourceData.parse({ ...sourceBase, replays: [replay] }).replays,
	).toEqual([replay]);
	expect(
		browserSourceData.parse({
			...sourceBase,
			replays: [
				{
					...replay,
					state: "running",
					errorCode: null,
					errorLabel: null,
					endedAt: null,
				},
			],
		}).replays[0]?.endedAt,
	).toBeNull();
	expect(browserSourceData.parse(sourceBase).replays).toEqual([]);
});

it("refuses a replay of the wrong shape", () => {
	expect(() =>
		browserSourceData.parse({
			...sourceBase,
			replays: [{ ...replay, state: "queued" }],
		}),
	).toThrow();
	expect(() =>
		browserSourceData.parse({
			...sourceBase,
			replays: [{ ...replay, replayId: undefined }],
		}),
	).toThrow();
});

it("reads the replay plan of a history detail, and treats it as optional", () => {
	const plan = {
		code: "async (page) => {}",
		blocked: null,
		blockedLabel: null,
	};
	expect(
		browserHistoryResult.parse({ history: { ...detail, replay: plan } }).history
			.replay,
	).toEqual(plan);
	const blocked = {
		code: "",
		blocked: "replay_incomplete",
		blockedLabel: "記録されていない操作や値があるため実行できません",
	};
	expect(
		browserHistoryResult.parse({ history: { ...detail, replay: blocked } })
			.history.replay,
	).toEqual(blocked);
	expect(
		browserHistoryResult.parse({ history: detail }).history.replay,
	).toBeUndefined();
	expect(() =>
		browserHistoryResult.parse({
			history: { ...detail, replay: { code: 1, blocked: null } },
		}),
	).toThrow();
});
