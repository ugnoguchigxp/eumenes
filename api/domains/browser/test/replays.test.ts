import { afterEach, expect, test } from "bun:test";
import { BrowserDriverError } from "../contracts/ports";
import type { HistoryAction } from "../contracts/history";
import { insertHistory, historyRow } from "../repository";
import {
	OWNER,
	connect,
	fakeBrave,
	parkedRunner,
	runCleanup,
	setup,
	startRunningTask,
	until,
	type Env,
} from "./fakes";

afterEach(runCleanup);

const YOUTUBE: HistoryAction[] = [
	{
		seq: 1,
		kind: "navigate",
		url: "https://www.youtube.com/results?search_query={{keyword}}",
	},
	{
		seq: 2,
		kind: "click",
		code: "await page.locator('ytd-video-renderer').first().waitFor();",
	},
	{ seq: 3, kind: "capture", value: "viewport" },
];

async function seed(
	env: Env,
	over: Partial<{
		place: string;
		actions: HistoryAction[];
		variables: { name: string; label: string }[];
	}> = {},
) {
	const id = crypto.randomUUID();
	await env.store.write((db) =>
		insertHistory(
			db,
			id,
			OWNER,
			{
				title: "YouTubeでAI関連動画を再生する",
				request: "YouTubeで検索して再生する",
				place: over.place ?? "www.youtube.com",
				variables: (
					over.variables ?? [{ name: "keyword", label: "検索語" }]
				).map((v) => ({ ...v, slots: [] })),
				steps: [],
				actions: over.actions ?? YOUTUBE,
				sourceTaskId: crypto.randomUUID(),
				hasCommit: false,
			},
			1_000,
		),
	);
	return id;
}
const history = (env: Env, id: string) =>
	env.store.read((db) => historyRow(db, id)!);
const start = (
	env: Env,
	historyId: string,
	values: Record<string, string> = { keyword: "AI関連" },
	expectedRevision = 1,
) =>
	env.store.write((db) =>
		env.service.startReplayInTransaction(db, OWNER, {
			historyId,
			expectedRevision,
			values,
		}),
	);
const replays = (env: Env) =>
	env.store.read(
		(db) => env.service.sourceInTransaction(db, OWNER).data.replays,
	);
const ended = async (env: Env, replayId: string) => {
	await until(
		() =>
			replays(env).find((r) => r.replayId === replayId)?.state !== "running",
	);
	return replays(env).find((r) => r.replayId === replayId)!;
};
const rejected = (p: Promise<unknown>) =>
	p.then(
		() => "accepted",
		(e: Error) => e.message,
	);

test("a replay opens a new tab at the place and runs the code with the values, then counts on the history", async () => {
	const env = setup();
	const tabRef = await connect(env);
	const id = await seed(env);
	const { replayId } = await start(env, id);
	expect(replays(env)[0]).toMatchObject({
		replayId,
		historyId: id,
		state: "running",
		errorCode: null,
		errorLabel: null,
		endedAt: null,
	});
	const done = await ended(env, replayId);
	expect(done).toMatchObject({ state: "completed", errorCode: null });
	expect(done.endedAt).toBeGreaterThanOrEqual(done.startedAt);
	expect(env.driver.calls.filter((c) => c.startsWith("newTab:"))).toEqual([
		"newTab:https://www.youtube.com/",
	]);
	expect(env.driver.replayCodes).toHaveLength(1);
	const code = env.driver.replayCodes[0]!;
	expect(code).toContain("'use strict';");
	expect(code).toContain('const vars = Object.freeze({"keyword":"AI関連"});');
	expect(code).toContain(
		"await page.goto(`https://www.youtube.com/results?search_query=${encodeURIComponent(vars.keyword)}`);",
	);
	expect(code).toContain("waitFor();");
	// The new tab is selected before the code runs, and the user's own tab is untouched.
	const order = env.driver.calls.filter((c) =>
		/^(newTab|selectTab|runReplay)/.test(c),
	);
	expect(order[0]).toBe("newTab:https://www.youtube.com/");
	expect(order.at(-1)).toBe("runReplay");
	expect(env.driver.tabs.length).toBe(2);
	expect(env.service.tabs().some((t) => t.tabRef === tabRef)).toBe(true);
	const h = history(env, id);
	expect(h).toMatchObject({
		revision: 1,
		run_count: 2,
		failure_count: 0,
		last_outcome: "completed",
	});
	expect(h.last_used_at).toBeGreaterThan(1_000);
	expect(h.actions_json).toBe(JSON.stringify(YOUTUBE));
});

test("while disconnected the replay connects first", async () => {
	const env = setup();
	await env.service.setting.save(fakeBrave(env.dir));
	await env.service.ready;
	const id = await seed(env);
	const { replayId } = await start(env, id);
	expect((await ended(env, replayId)).state).toBe("completed");
	expect(env.driver.connectCount).toBe(1);
	expect(env.driver.calls).toContain("runReplay");
});

test("a replay that cannot connect fails as browser_disconnected and counts as a failure", async () => {
	const env = setup();
	const id = await seed(env);
	const { replayId } = await start(env, id);
	expect(await ended(env, replayId)).toMatchObject({
		state: "failed",
		errorCode: "browser_disconnected",
		errorLabel: "ブラウザに接続されていません",
	});
	expect(env.driver.replayCodes).toEqual([]);
	expect(history(env, id)).toMatchObject({
		failure_count: 1,
		last_outcome: "failed",
	});
});

test("a failure of the code ends the replay with a classified code; counts follow", async () => {
	const env = setup();
	await connect(env);
	const id = await seed(env);
	env.driver.replayError = new BrowserDriverError("action_timeout", true);
	const a = await start(env, id);
	expect(await ended(env, a.replayId)).toMatchObject({
		state: "failed",
		errorCode: "replay_timeout",
	});
	env.driver.replayError = new BrowserDriverError("mcp_error", true);
	const b = await start(env, id);
	expect(await ended(env, b.replayId)).toMatchObject({
		state: "failed",
		errorCode: "replay_failed",
		errorLabel: "実行中にエラーが起きました",
	});
	env.driver.replayError = new BrowserDriverError("browser_closed", true);
	const c = await start(env, id);
	expect((await ended(env, c.replayId)).errorCode).toBe("browser_disconnected");
	expect(history(env, id)).toMatchObject({
		run_count: 1,
		failure_count: 3,
		revision: 1,
	});
});

test("the time limit ends a replay that does not finish as replay_timeout", async () => {
	const env = setup({ replayMs: 30 });
	await connect(env);
	env.driver.replayGate = new Promise(() => {});
	const id = await seed(env);
	const { replayId } = await start(env, id);
	expect(await ended(env, replayId)).toMatchObject({
		state: "failed",
		errorCode: "replay_timeout",
	});
});

test("cancel stops the code; the replay stays running, and busy, until it has really stopped, then ends as cancelled without counting", async () => {
	const env = setup();
	await connect(env);
	let release!: () => void;
	let stopped!: () => void;
	env.driver.replayGate = new Promise<void>((r) => (release = r));
	env.driver.replayStopGate = new Promise<void>((r) => (stopped = r));
	const id = await seed(env);
	const { replayId } = await start(env, id);
	await until(() => env.driver.calls.includes("runReplay"));
	await env.store.write((db) =>
		env.service.cancelReplayInTransaction(db, OWNER, replayId),
	);
	env.service.abortReplay(replayId);
	await Bun.sleep(30);
	// Still running: the code has not stopped, so the browser is not free.
	expect(replays(env)[0]).toMatchObject({ state: "running", endedAt: null });
	expect(await rejected(start(env, id))).toBe("replay_busy");
	stopped();
	expect(await ended(env, replayId)).toMatchObject({
		state: "cancelled",
		errorCode: null,
	});
	expect(history(env, id)).toMatchObject({ run_count: 1, failure_count: 0 });
	expect(
		await rejected(
			env.store.write((db) =>
				env.service.cancelReplayInTransaction(db, OWNER, replayId),
			),
		),
	).toBe("replay_not_running");
	expect(
		await rejected(
			env.store.write((db) =>
				env.service.cancelReplayInTransaction(db, OWNER, crypto.randomUUID()),
			),
		),
	).toBe("browser_replay_not_found");
	release();
	// The slot is free again.
	env.driver.replayGate = null;
	env.driver.replayStopGate = null;
	const next = await start(env, id);
	expect((await ended(env, next.replayId)).state).toBe("completed");
});

test("a cancel that comes before the job begins ends the replay without running anything", async () => {
	const env = setup();
	await connect(env);
	const id = await seed(env);
	// The job is claimed on commit; the abort arrives in the same turn, as the control queue's effect would.
	const { replayId } = await start(env, id);
	env.service.abortReplay(replayId);
	const done = await ended(env, replayId);
	expect(done.state).toBe("cancelled");
	expect(env.driver.replayCodes).toEqual([]);
	expect(env.driver.calls.some((c) => c.startsWith("newTab:"))).toBe(false);
});

test("the time limit does not end the replay until the code has stopped", async () => {
	const env = setup({ replayMs: 30 });
	await connect(env);
	let stopped!: () => void;
	env.driver.replayGate = new Promise(() => {});
	env.driver.replayStopGate = new Promise<void>((r) => (stopped = r));
	const id = await seed(env);
	const { replayId } = await start(env, id);
	await Bun.sleep(150);
	expect(replays(env)[0]!.state).toBe("running");
	stopped();
	expect(await ended(env, replayId)).toMatchObject({
		state: "failed",
		errorCode: "replay_timeout",
	});
});

test("one replay at a time, and not beside a task or a capture of the owner", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	let release!: () => void;
	env.driver.replayGate = new Promise<void>((r) => (release = r));
	const id = await seed(env);
	const first = await start(env, id);
	expect(await rejected(start(env, id))).toBe("replay_busy");
	// The browser is the replay's alone while it runs.
	expect(
		await rejected(
			env.service.startTask({
				owner: OWNER,
				conversationId: "main",
				origin: "screen",
				requestId: crypto.randomUUID(),
				request: "ページを開く",
				tabRef,
			}),
		),
	).toBe("replay_busy");
	expect(
		await rejected(
			env.service.startCapture({
				requestId: crypto.randomUUID(),
				owner: OWNER,
				conversationId: "main",
				origin: "screen",
				tabRef,
				range: "viewport",
			}),
		),
	).toBe("replay_busy");
	release();
	await ended(env, first.replayId);
	// And a replay does not start while a task runs.
	await startRunningTask(env, tabRef);
	expect(await rejected(start(env, id))).toBe("replay_busy");
});

test("refusals: unknown history, changed revision, values, operations without code, rejected code, blocked addresses", async () => {
	const env = setup();
	await connect(env);
	const id = await seed(env);
	expect(await rejected(start(env, crypto.randomUUID()))).toBe(
		"browser_history_not_found",
	);
	expect(await rejected(start(env, id, { keyword: "x" }, 2))).toBe(
		"browser_history_conflict",
	);
	for (const values of [
		{},
		{ keyword: "" },
		{ keyword: "   " },
		{ keyword: "x", other: "y" },
		{ other: "y" },
	] as Record<string, string>[])
		expect(await rejected(start(env, id, values)), JSON.stringify(values)).toBe(
			"replay_values_invalid",
		);
	const noCode = await seed(env, {
		actions: [{ seq: 1, kind: "click", element: "ボタン" }],
		variables: [],
	});
	expect(await rejected(start(env, noCode, {}))).toBe("replay_incomplete");
	const unsafe = await seed(env, {
		actions: [{ seq: 1, kind: "click", code: "await page.evaluate(() => 1);" }],
		variables: [],
	});
	expect(await rejected(start(env, unsafe, {}))).toBe("replay_code_rejected");
	const redacted = await seed(env, {
		actions: [
			{
				seq: 1,
				kind: "type",
				value: "<許可を得て入力した値>",
				code: "await page.locator('input').fill('<許可を得て入力した値>');",
			},
		],
		variables: [],
	});
	expect(await rejected(start(env, redacted, {}))).toBe("replay_incomplete");
	const privateGoto = await seed(env, {
		actions: [{ seq: 1, kind: "navigate", url: "http://192.168.0.1/admin" }],
		variables: [],
	});
	expect(await rejected(start(env, privateGoto, {}))).toBe(
		"replay_destination_blocked",
	);
	const privatePlace = await seed(env, {
		place: "localhost",
		actions: [{ seq: 1, kind: "click", code: "await page.reload();" }],
		variables: [],
	});
	expect(await rejected(start(env, privatePlace, {}))).toBe(
		"replay_destination_blocked",
	);
	expect(replays(env)).toEqual([]);
	expect(env.driver.replayCodes).toEqual([]);
});

test("a name that resolves to a private address is refused when the replay runs", async () => {
	const env = setup({ resolveHost: async () => ["10.0.0.5"] });
	await connect(env);
	const id = await seed(env);
	const { replayId } = await start(env, id);
	expect(await ended(env, replayId)).toMatchObject({
		state: "failed",
		errorCode: "replay_destination_blocked",
		errorLabel: "開けない移動先が含まれています",
	});
	expect(env.driver.replayCodes).toEqual([]);
	expect(env.driver.calls.some((c) => c.startsWith("newTab:"))).toBe(false);
});

test("a replay that was running when the backend restarted failed as interrupted", async () => {
	const env = setup();
	await connect(env);
	const id = await seed(env);
	const replayId = crypto.randomUUID();
	await env.store.write((db) => {
		db.query(
			"INSERT INTO browser_replays(id,owner,history_id,state,started_at) VALUES(?,?,?, 'running', 5)",
		).run(replayId, OWNER, id);
	});
	await env.queue.close(100);
	await env.store.close();
	const again = setup({ dir: env.dir });
	await again.service.ready;
	expect(replays(again)).toMatchObject([
		{
			replayId,
			state: "failed",
			errorCode: "replay_interrupted",
			errorLabel: "サーバーの再起動で中断しました",
		},
	]);
	expect(history(again, id)).toMatchObject({
		failure_count: 1,
		last_outcome: "failed",
	});
});

test("the workspace source lists the newest ten replays, newest first, and its revision moves with them", async () => {
	const env = setup();
	await connect(env);
	const id = await seed(env);
	const revision = () =>
		env.store.read((db) => env.service.sourceInTransaction(db, OWNER).revision);
	const before = revision();
	const ids: string[] = [];
	for (let i = 0; i < 11; i++) {
		const r = await start(env, id);
		ids.push(r.replayId);
		await ended(env, r.replayId);
	}
	expect(revision()).toBeGreaterThan(before);
	const listed = replays(env);
	expect(listed).toHaveLength(10);
	expect(listed[0]!.replayId).toBe(ids[10]!);
	expect(listed.map((r) => r.state)).toEqual(Array(10).fill("completed"));
	expect(Object.keys(listed[0]!).sort()).toEqual([
		"endedAt",
		"errorCode",
		"errorLabel",
		"historyId",
		"replayId",
		"startedAt",
		"state",
	]);
});

test("the ledger keeps no values and no code", async () => {
	const env = setup();
	await connect(env);
	const id = await seed(env);
	const { replayId } = await start(env, id, { keyword: "ひみつの検索語" });
	await ended(env, replayId);
	const dump = env.store.read((db) =>
		JSON.stringify([
			db.query("SELECT * FROM browser_replays").all(),
			db.query("SELECT payload_json FROM queue_jobs").all(),
		]),
	);
	expect(dump).not.toContain("ひみつの検索語");
	expect(dump).not.toContain("page.goto");
});

test("the history detail carries exactly what a start would run and why it would be refused", async () => {
	const env = setup();
	await connect(env);
	const id = await seed(env);
	const replay = env.service.historyDetail(OWNER, id).replay;
	expect(replay).toEqual({
		code: [
			"await page.goto(`https://www.youtube.com/results?search_query=${encodeURIComponent(vars.keyword)}`);",
			"await page.locator('ytd-video-renderer').first().waitFor();",
		].join("\n"),
		blocked: null,
		blockedLabel: null,
	});
	// The code a start hands the driver holds those lines, whole, and nothing else of the history.
	const { replayId } = await start(env, id);
	await ended(env, replayId);
	expect(env.driver.replayCodes[0]).toContain(replay.code);
	const bad = await seed(env, {
		actions: [{ seq: 1, kind: "click", code: "await page.evaluate(1);" }],
		variables: [],
	});
	expect(env.service.historyDetail(OWNER, bad).replay).toMatchObject({
		blocked: "replay_code_rejected",
		blockedLabel: "このコードは安全のため実行できません",
	});
	expect(await rejected(start(env, bad, {}))).toBe("replay_code_rejected");
});
