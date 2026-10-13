import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configureLogging } from "../../../infrastructure/logger";
import {
	setupAgent,
	until,
	type AgentData,
	type AgentHarness,
} from "./memory-agent.fixture";

const open: AgentHarness[] = [];
afterEach(async () => {
	configureLogging({ level: "silent" });
	for (const h of open.splice(0)) await h.close();
});
async function setup(options?: Parameters<typeof setupAgent>[0]) {
	const h = await setupAgent(options);
	open.push(h);
	return h;
}
/** The model's answer for the agent: a JSON object with these ops. */
const answer = (...ops: Array<Record<string, unknown>>) =>
	JSON.stringify({ ops });
const labelOf = (data: AgentData, role: "user" | "assistant" = "user") =>
	data.turns.find((turn) => turn.role === role)?.label ?? "";

test("A1: a habit the user mentions is remembered by the agent; the long-term text stays and the short-term layer shows it", async () => {
	const h = await setup();
	await h.seed("コーヒーが好き", "drink.coffee");
	const before = await h.window();
	expect(before.longTerm.text).toContain("コーヒーが好き");
	await h.say("user", "毎朝コーヒーを飲んでる");
	h.inference.state.script = (data) =>
		answer({
			type: "remember",
			turn: labelOf(data),
			requested: false,
			kind: "habit",
			semanticKey: "morning.coffee",
			text: "毎朝コーヒーを飲む",
			quote: "毎朝コーヒーを飲んでる",
		});
	await h.schedule();
	await h.settled();
	const items = h.memory.list();
	const added = items.find((item) => item.semanticKey === "morning.coffee");
	// What the agent concluded on its own is not stored as something the user confirmed.
	expect(added).toMatchObject({
		capturedBy: "agent",
		kind: "habit",
		origin: "agent_inferred",
	});
	expect(items.find((i) => i.semanticKey === "drink.coffee")).toMatchObject({
		capturedBy: "manual",
		origin: "user_confirmed",
	});
	const after = await h.window();
	expect(after.longTerm.text).toBe(before.longTerm.text);
	expect(after.shortTerm.text).toContain("最近覚えたこと");
	expect(after.shortTerm.text).toContain("毎朝コーヒーを飲む");
	// The agent's own change does not expire a run that read the earlier window.
	const stale = h.store.write((db) =>
		h.memory.validateWindowInTransaction(
			db,
			"run-other",
			h.memory.preparedWindow(before),
		),
	);
	expect(await stale).toEqual({ ok: true });
});

test("A2: an explicit request is recorded as asked for", async () => {
	const h = await setup();
	await h.say("user", "お茶派なの、覚えておいて");
	h.inference.state.script = (data) =>
		answer({
			type: "remember",
			turn: labelOf(data),
			requested: true,
			kind: "preference",
			semanticKey: "drink.tea",
			text: "お茶派",
			quote: "お茶派",
		});
	await h.schedule();
	await h.settled();
	expect(h.memory.list()).toMatchObject([
		{
			semanticKey: "drink.tea",
			capturedBy: "request",
			origin: "user_confirmed",
		},
	]);
	expect(h.memory.list()[0]?.evidence[0]?.quote).toBe("お茶派");
});

test("A3: a refused explicit request becomes a notice that the answer carrying it clears", async () => {
	const h = await setup();
	await h.say("user", "お茶派なの、覚えておいて");
	h.inference.state.script = (data) =>
		answer({
			type: "remember",
			turn: labelOf(data),
			requested: true,
			kind: "preference",
			semanticKey: "drink.tea",
			text: "コーヒー派",
			quote: "コーヒー派",
		});
	await h.schedule();
	await h.settled();
	expect(h.memory.list()).toHaveLength(0);
	const window = await h.window();
	expect(window.notices).toHaveLength(1);
	expect(window.notices[0]?.text).toBe(
		"「お茶派なの、覚えておいて」の記憶の依頼は保存できませんでした（発言を確認できませんでした）。",
	);
	// Adopting the answer that carried the notice removes it; an unadopted run leaves it for the next turn.
	await h.store.write((db) =>
		h.memory.clearNoticesInTransaction(db, "c1", [window.notices[0]!.id]),
	);
	expect((await h.window()).notices).toHaveLength(0);
});

test("A3b: an inference that disagrees with an item the user confirmed is refused and told to the conversation", async () => {
	const h = await setup();
	await h.seed("お茶が好き", "drink.tea");
	await h.say("user", "最近はコーヒーばかり飲んでるな");
	h.inference.state.script = (data) =>
		answer({
			type: "remember",
			turn: labelOf(data),
			requested: false,
			kind: "preference",
			semanticKey: "drink.tea",
			text: "コーヒーが好き",
			quote: "コーヒーばかり飲んでる",
		});
	await h.schedule();
	await h.settled();
	expect(h.memory.list()).toMatchObject([
		{ text: "お茶が好き", origin: "user_confirmed", capturedBy: "manual" },
	]);
	expect((await h.window()).notices.map((notice) => notice.text)).toEqual([
		"「お茶が好き」と違う内容の発言がありました。記憶を更新するときは、覚え直すよう伝えてください。",
	]);
});

test("A4: an item the user stopped is not written again unless they ask", async () => {
	const h = await setup();
	const stopped = await h.seed("お茶が好き", "drink.tea");
	await h.memory.stop(stopped.id, stopped.revision);
	await h.say("user", "お茶が好きだよ");
	h.inference.state.script = (data) =>
		answer({
			type: "remember",
			turn: labelOf(data),
			requested: false,
			kind: "preference",
			semanticKey: "drink.tea",
			text: "お茶が好き",
			quote: "お茶が好き",
		});
	await h.schedule();
	await h.settled();
	expect(h.memory.list(true)).toHaveLength(1);
	expect(h.memory.list(false)).toHaveLength(0);
	// Asked for again: written.
	await h.say("user", "やっぱりお茶が好きだから覚えて");
	h.inference.state.script = (data) =>
		answer({
			type: "remember",
			turn: labelOf(data),
			requested: true,
			kind: "preference",
			semanticKey: "drink.tea",
			text: "お茶が好き",
			quote: "お茶が好き",
		});
	await h.schedule();
	await h.settled(2);
	expect(h.memory.list(false)).toMatchObject([
		{ semanticKey: "drink.tea", capturedBy: "request", status: "active" },
	]);
});

test("A5: stopping from conversation is the run's own change; another run in flight is expired, and the layer is rebuilt", async () => {
	const h = await setup();
	const item = await h.seed("コーヒーが好き", "drink.coffee");
	const first = await h.window();
	expect(first.longTerm.text).toContain("コーヒーが好き");
	await h.say("user", "その記憶はもう使わないで");
	const stopRun = "run-m2";
	h.inference.state.script = (data) =>
		answer({
			type: "stop",
			turn: labelOf(data),
			requested: true,
			ref: data.longTerm[0]?.ref,
		});
	const prepared = h.memory.preparedWindow(first);
	await h.schedule();
	await h.settled();
	expect(h.memory.list(true)[0]).toMatchObject({
		id: item.id,
		status: "inactive",
	});
	const verdict = (runId: string) =>
		h.store.write((db) =>
			h.memory.validateWindowInTransaction(db, runId, prepared),
		);
	// The user message's run id is the turn's run: that run is not expired by its own memory step.
	expect(await verdict(stopRun)).toEqual({ ok: true });
	expect(await verdict("run-elsewhere")).toEqual({
		ok: false,
		reason: "memory_stale",
	});
	const after = await h.window();
	expect(after.longTerm.text).not.toContain("コーヒーが好き");
	expect(after.notices.map((n) => n.text)).toEqual([
		"利用を止めました。完全に消すには設定の「メモリー」から操作してください。",
	]);
});

test("A6: stop without the user having asked is refused", async () => {
	const h = await setup();
	await h.seed("コーヒーが好き", "drink.coffee");
	await h.say("user", "最近ちょっと飽きてきたかも");
	h.inference.state.script = (data) =>
		answer({
			type: "stop",
			turn: labelOf(data),
			requested: false,
			ref: data.longTerm[0]?.ref,
		});
	await h.schedule();
	await h.settled();
	expect(h.memory.list()).toMatchObject([{ status: "active" }]);
	// Not asked for, so no notice either.
	expect((await h.window()).notices).toHaveLength(0);
});

test("A7: a note appears in the short-term layer and goes when closed, without expiring a run in flight", async () => {
	const h = await setup();
	const before = await h.window();
	await h.say("user", "Rust移行の調査を始めた");
	h.inference.state.script = (data) =>
		answer({
			type: "note_add",
			turn: labelOf(data),
			kind: "activity",
			text: "Rust移行の調査中",
		});
	await h.schedule();
	await h.settled();
	const mid = await h.window();
	expect(mid.shortTerm.text).toContain("Rust移行の調査中");
	expect(
		await h.store.write((db) =>
			h.memory.validateWindowInTransaction(
				db,
				"run-other",
				h.memory.preparedWindow(before),
			),
		),
	).toEqual({ ok: true });
	await h.say("user", "調査は終わった");
	h.inference.state.script = (data) =>
		answer({
			type: "note_close",
			ref: data.shortTerm[0]?.ref,
			status: "resolved",
		});
	await h.schedule();
	await h.settled(2);
	expect((await h.window()).shortTerm.text).not.toContain("Rust移行の調査中");
	expect(h.memory.shortTerm("c1")).toHaveLength(0);
});

test("A8: a tendency needs two live pieces of evidence, and a bad operation costs only itself", async () => {
	const h = await setup();
	await h.seed("コーヒーが好き", "drink.coffee");
	await h.say("user", "最近よく走っている");
	// One piece of evidence: that operation is dropped, the note beside it is kept.
	h.inference.state.script = (data) =>
		answer(
			{ type: "tendency_add", text: "朝型", evidenceRefs: ["m1"] },
			{
				type: "note_add",
				turn: labelOf(data),
				kind: "memo",
				text: "ランニング",
			},
		);
	await h.schedule();
	await h.settled();
	expect(h.memory.tendencies()).toEqual([]);
	expect(h.memory.shortTerm("c1").map((n) => n.text)).toEqual(["ランニング"]);
	expect(h.inference.state.rejected).toEqual([]);
	// Two refs, one of which does not exist: this operation is refused, the rest stand.
	await h.say("user", "毎朝走ってる");
	h.inference.state.script = (data) =>
		answer(
			{ type: "tendency_add", text: "朝型", evidenceRefs: ["m1", "m9"] },
			{
				type: "note_add",
				turn: labelOf(data),
				kind: "memo",
				text: "朝のランニング",
			},
		);
	await h.schedule();
	await h.settled(2);
	expect(h.memory.tendencies()).toEqual([]);
	expect(h.memory.shortTerm("c1").map((n) => n.text)).toEqual([
		"ランニング",
		"朝のランニング",
	]);
	// Two live pieces of evidence: written.
	await h.say("user", "ジムにも通ってる");
	h.inference.state.script = () =>
		answer({ type: "tendency_add", text: "朝型", evidenceRefs: ["m1", "n1"] });
	await h.schedule();
	await h.settled(3);
	expect(h.memory.tendencies()).toMatchObject([{ text: "朝型", revision: 1 }]);
});

test("A9: an answer that is not JSON rejects everything and the messages are not read again", async () => {
	const h = await setup();
	await h.say("user", "毎朝コーヒーを飲んでる");
	h.inference.state.script = () => "すみません、わかりません";
	await h.schedule();
	await h.settled();
	expect(h.memory.list(true)).toHaveLength(0);
	expect(h.inference.state.rejected).toEqual(["memory_agent_invalid_output"]);
	expect(h.cursor()).not.toBeNull();
	await h.schedule();
	await pauseBriefly();
	expect(h.inference.state.calls).toHaveLength(1);
});

test("A10: when inference cannot be had the messages stay unread and are retried at the next start", async () => {
	const h = await setup();
	const first = await h.say("user", "毎朝コーヒーを飲んでる");
	const start = h.ordinal(first) - 1;
	h.inference.state.unavailable = true;
	await h.schedule();
	await h.settled();
	// No attempt was made: nothing read, nothing counted.
	expect(h.cursor()).toBe(start);
	expect(h.failures()).toBe(0);
	expect(h.inference.state.calls).toHaveLength(0);
	h.inference.state.unavailable = false;
	h.inference.state.script = () => answer();
	await h.say("user", "もう一つ");
	await h.schedule();
	await h.settled(2);
	expect(h.inference.state.calls).toHaveLength(1);
	// Both messages, read together this time.
	expect(h.inference.state.calls[0]?.data.turns.map((t) => t.label)).toEqual([
		"u1",
		"u2",
	]);
	expect(h.cursor()).toBeGreaterThan(start);
});

test("A11: starts at acceptance and at adoption; the second start queues its own job behind the first", async () => {
	const h = await setup();
	await h.say("user", "毎朝コーヒーを飲んでる");
	let release!: () => void;
	h.inference.state.gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	h.inference.state.script = () => answer();
	// The acceptance start: its job reads the user's message and is held in inference.
	await h.schedule();
	await until(() => h.inference.state.calls.length === 1, "first call");
	await h.say("assistant", "コーヒーがお好きなんですね");
	// The adoption start: a second job for the same conversation, waiting for the first (one at a time per conversation).
	await h.schedule();
	expect(h.jobs()).toHaveLength(2);
	expect(h.inference.state.calls).toHaveLength(1);
	expect(h.inference.state.calls[0]?.data.turns.map((t) => t.label)).toEqual([
		"u1",
	]);
	release();
	await h.settled(2);
	// The successor read what arrived since: the answer.
	expect(h.inference.state.calls.map((c) => c.data.turns.length)).toEqual([
		1, 1,
	]);
	expect(h.inference.state.calls[1]?.data.turns[0]).toMatchObject({
		label: "a1",
		role: "assistant",
	});
});

test("A11: when the first job already read everything, a successor reads nothing", async () => {
	const h = await setup();
	await h.say("user", "毎朝コーヒーを飲んでる");
	await h.say("assistant", "コーヒーがお好きなんですね");
	h.inference.state.script = () => answer();
	await h.store.write((db) => {
		h.memory.scheduleAgentInTransaction(db, "c1");
		h.memory.scheduleAgentInTransaction(db, "c1");
	});
	// Same cursor and ordinal: one job.
	expect(h.jobs()).toHaveLength(1);
	h.queue.wake();
	await h.settled();
	// A successor queued afterwards for the same conversation finds the cursor at the end.
	await h.store.write((db) => h.memory.scheduleAgentInTransaction(db, "c1"));
	expect(h.jobs()).toHaveLength(1);
	expect(h.inference.state.calls).toHaveLength(1);
});

test("A13: memory off, a missing wiring, or an empty conversation queue nothing", async () => {
	const h = await setup();
	await h.say("user", "こんにちは");
	await h.memory.setEnabled(false);
	await h.schedule();
	expect(h.jobs()).toHaveLength(0);
	await h.memory.setEnabled(true);
	await h.schedule("nobody");
	expect(h.jobs()).toHaveLength(0);
	const bare = await setup({ inference: false });
	await bare.say("user", "こんにちは");
	await bare.schedule();
	expect(bare.jobs()).toHaveLength(0);
});

test("A13: while the journal is inconsistent no agent is queued", async () => {
	const h = await setup();
	await h.say("user", "こんにちは");
	writeFileSync(join(h.dir, "journal.jsonl"), "not json\n");
	expect((await h.memory.recover()).healthy).toBe(false);
	await h.schedule();
	expect(h.jobs()).toHaveLength(0);
});

test("A15: more than eight unread messages are read eight at a time, the settle queueing the next job", async () => {
	const h = await setup();
	// An existing backlog (a conversation the agent already knows).
	await h.setCursor(0);
	for (let i = 1; i <= 10; i++) await h.say("user", `発言${i}`);
	h.inference.state.script = () => answer();
	await h.schedule();
	await h.settled(2);
	expect(h.inference.state.calls.map((c) => c.data.turns.length)).toEqual([
		8, 2,
	]);
	expect(h.inference.state.calls[1]?.data.turns[0]?.text).toBe("発言9");
});

test("A16: operations are independent: a later one refused because the earlier replaced its target leaves the earlier in place", async () => {
	const h = await setup();
	await h.seed("コーヒーが好き", "drink.coffee");
	await h.say("user", "コーヒーはブラックで飲む派だよ");
	h.inference.state.script = (data) =>
		answer(
			{
				type: "remember",
				turn: labelOf(data),
				requested: true,
				kind: "preference",
				semanticKey: "drink.coffee",
				text: "コーヒーはブラック",
				quote: "コーヒーはブラックで飲む",
			},
			{
				type: "update",
				turn: labelOf(data),
				requested: false,
				ref: "m1",
				text: "コーヒーは砂糖入り",
				quote: "ブラック",
			},
		);
	const lines: string[] = [];
	configureLogging({
		level: "info",
		destination: { write: (line) => void lines.push(line) },
	});
	await h.schedule();
	await h.settled();
	expect(h.memory.list().map((item) => item.text)).toEqual([
		"コーヒーはブラック",
	]);
	const settled = lines
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.find((entry) => entry.event === "memory.agent_settled");
	expect(settled).toMatchObject({
		messageCount: 1,
		applied: 1,
		rejected: 1,
		requestedRejected: 0,
	});
	// Counts only: no text of the conversation or the memory reaches the log.
	expect(lines.join("")).not.toContain("ブラック");
});

test("the inference request is bounded and the agent runs on the auxiliary resource", async () => {
	const h = await setup();
	await h.say("user", "こんにちは");
	h.inference.state.script = () => answer();
	await h.schedule();
	await h.settled();
	const captured = h.inference.state.captured[0]!;
	expect(captured).toMatchObject({
		taskId: "memory-agent",
		authorityEpoch: 1,
		maxOutputTokens: 1200,
	});
	expect(Number(captured.executionGeneration)).toBeGreaterThan(0);
	expect(Number(captured.deadline) - Date.now()).toBeLessThanOrEqual(30_000);
	expect(captured.deadline).toBe(captured.taskDeadline);
	const [job] = h.jobs();
	expect(job).toMatchObject({
		scope: "memory",
		kind: "memory.agent.v1",
		lane: "background",
		state: "completed",
		maxAttempts: 1,
	});
	// The conversation model is never given a memory tool: the agent's data holds no instructions to call one.
	expect(h.inference.state.calls[0]?.system).toContain("OUTPUT_SCHEMA=");
});

test("a result that is not adopted releases its request, leaves the messages unread and counts a failure", async () => {
	const h = await setup();
	const first = await h.say("user", "毎朝コーヒーを飲んでる");
	const start = h.ordinal(first) - 1;
	h.inference.state.script = (data) =>
		answer({
			type: "remember",
			turn: labelOf(data),
			requested: false,
			kind: "habit",
			semanticKey: "morning.coffee",
			text: "毎朝コーヒーを飲む",
			quote: "毎朝コーヒーを飲んでる",
		});
	h.inference.state.accept = false;
	await h.schedule();
	await h.settled();
	expect(h.memory.list(true)).toHaveLength(0);
	expect(h.cursor()).toBe(start);
	expect(h.failures()).toBe(1);
	expect(h.heldRequests()).toEqual([]);
	// A failed inference is cancelled and flushed after the commit.
	h.inference.state.accept = true;
	h.inference.state.script = () => {
		throw new Error("boom");
	};
	await h.say("user", "もう一つ");
	await h.schedule();
	await h.settled(2);
	await until(() => h.inference.state.flushed.length > 0, "flush");
	expect(h.inference.state.cancelled).toContain("req-2");
	expect(h.inference.state.flushed).toContain("req-2");
	expect(h.cursor()).toBe(start);
	expect(h.failures()).toBe(2);
	expect(h.heldRequests()).toEqual([]);
});

test("a conversation the agent has never read starts at its latest user message, not at the beginning of its history", async () => {
	const h = await setup();
	for (let i = 1; i <= 12; i++) {
		await h.say("user", `昔の発言${i}`);
		await h.say("assistant", `昔の返事${i}`);
	}
	await h.say("user", "いまの発話");
	h.inference.state.script = () => answer();
	await h.schedule();
	await h.settled();
	expect(h.inference.state.calls).toHaveLength(1);
	expect(h.inference.state.calls[0]?.data.turns.map((t) => t.text)).toEqual([
		"いまの発話",
	]);
});

test("what was said while memory was off is never learned", async () => {
	const h = await setup();
	await h.say("user", "最初の発話");
	h.inference.state.script = () => answer();
	await h.schedule();
	await h.settled();
	await h.memory.setEnabled(false);
	await h.say("user", "オフの間の発話");
	await h.say("assistant", "オフの間の返事");
	await h.memory.setEnabled(true);
	const latest = h.store.read((db) =>
		h.conversation.latestOrdinalInTransaction(db, "c1"),
	);
	expect(h.cursor()).toBe(latest);
	await h.schedule();
	expect(h.jobs()).toHaveLength(1);
	// Setting the same value again moves nothing.
	await h.say("user", "オンの後の発話");
	await h.memory.setEnabled(true);
	expect(h.cursor()).toBe(latest);
	await h.schedule();
	await h.settled(2);
	expect(h.inference.state.calls[1]?.data.turns.map((t) => t.text)).toEqual([
		"オンの後の発話",
	]);
});

test("coming back from an unhealthy journal skips what was said meanwhile", async () => {
	const h = await setup();
	await h.say("user", "最初の発話");
	h.inference.state.script = () => answer();
	await h.schedule();
	await h.settled();
	const journal = join(h.dir, "journal.jsonl");
	writeFileSync(journal, "not json\n");
	expect((await h.memory.recover()).healthy).toBe(false);
	await h.say("user", "壊れている間の発話");
	rmSync(journal, { force: true });
	expect((await h.memory.recover()).healthy).toBe(true);
	const latest = h.store.read((db) =>
		h.conversation.latestOrdinalInTransaction(db, "c1"),
	);
	expect(h.cursor()).toBe(latest);
	await h.schedule();
	expect(h.jobs()).toHaveLength(1);
	// A recovery that was never preceded by a failure moves nothing.
	await h.say("user", "その後の発話");
	expect((await h.memory.recover()).healthy).toBe(true);
	expect(h.cursor()).toBe(latest);
});

test("three failed runs over the same messages skip them; a good run clears the count", async () => {
	const h = await setup();
	h.inference.state.script = () => {
		throw new Error("boom");
	};
	const first = await h.say("user", "一つ目");
	const start = h.ordinal(first) - 1;
	await h.schedule();
	await h.settled(1);
	expect(h.failures()).toBe(1);
	// A good run in between clears it.
	h.inference.state.script = () => answer();
	await h.say("user", "二つ目");
	await h.schedule();
	await h.settled(2);
	expect(h.failures()).toBe(0);
	expect(h.cursor()).toBeGreaterThan(start);
	// Three failures in a row: the third skips the messages it read.
	h.inference.state.script = () => {
		throw new Error("boom");
	};
	const before = h.cursor();
	let last = "";
	for (let i = 1; i <= 3; i++) {
		last = await h.say("user", `失敗${i}`);
		await h.schedule();
		await h.settled(2 + i);
		expect(h.failures()).toBe(i === 3 ? 0 : i);
	}
	expect(h.cursor()).toBe(h.ordinal(last));
	expect(h.cursor()).toBeGreaterThan(before!);
	// The skipped messages are not read again.
	h.inference.state.script = () => answer();
	await h.say("user", "四つ目");
	await h.schedule();
	await h.settled(6);
	expect(h.inference.state.calls.at(-1)?.data.turns.map((t) => t.text)).toEqual(
		["四つ目"],
	);
});

test("a batch stops at 16 KiB of turn text (the first message is always read)", async () => {
	const h = await setup();
	await h.setCursor(0);
	for (let i = 0; i < 8; i++) await h.say("user", "あ".repeat(2000));
	h.inference.state.script = () => answer();
	await h.schedule();
	await h.settled(2);
	// 6000 bytes each: two fit in 16 KiB.
	expect(h.inference.state.calls[0]?.data.turns).toHaveLength(2);
});

test("the request of a job is released when the job is cancelled", async () => {
	const h = await setup();
	await h.say("user", "毎朝コーヒーを飲んでる");
	h.inference.state.gate = new Promise<void>(() => {});
	await h.schedule();
	await until(() => h.inference.state.calls.length === 1, "inference started");
	expect(h.heldRequests()).toHaveLength(1);
	const [job] = h.jobs();
	await h.queue.cancel(job!.id);
	await until(() => h.inference.state.flushed.includes("req-1"), "flushed");
	expect(h.inference.state.cancelled).toEqual(["req-1"]);
	expect(h.heldRequests()).toEqual([]);
});

test("a job lost to a restart or an expired lease (no input) still releases its request", async () => {
	const h = await setup();
	await h.say("user", "毎朝コーヒーを飲んでる");
	const handler = h.memory.agentHandler();
	const claim = {
		jobId: "lost-job",
		generation: 1,
		payload: { conversationId: "c1" },
	};
	const prepared = await h.store.write((db) =>
		handler.prepareInTransaction(db, claim),
	);
	expect(prepared.status).toBe("ready");
	expect(h.heldRequests()).toEqual([{ jobId: "lost-job", requestId: "req-1" }]);
	// The in-process state is gone: the queue settles it with no input.
	await h.store.write((db) =>
		handler.settleInTransaction(db, claim, null, {
			type: "interrupted",
			errorCode: "lease_lost",
		}),
	);
	await until(() => h.inference.state.flushed.includes("req-1"), "flushed");
	expect(h.inference.state.cancelled).toEqual(["req-1"]);
	expect(h.heldRequests()).toEqual([]);
});

test("a result that arrives while memory has been switched off changes nothing", async () => {
	const h = await setup();
	await h.say("user", "毎朝コーヒーを飲んでる");
	let release!: () => void;
	h.inference.state.gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	h.inference.state.script = (data) =>
		answer({
			type: "remember",
			turn: labelOf(data),
			requested: false,
			kind: "habit",
			semanticKey: "morning.coffee",
			text: "毎朝コーヒーを飲む",
			quote: "毎朝コーヒーを飲んでる",
		});
	await h.schedule();
	await until(() => h.inference.state.calls.length === 1, "inference started");
	await h.memory.setEnabled(false);
	const windowRows = () =>
		h.store.read(
			(db) =>
				(
					db.query("SELECT COUNT(*) AS n FROM memory_context_window").get() as {
						n: number;
					}
				).n,
		);
	const before = windowRows();
	release();
	await h.settled();
	expect(h.memory.list(true)).toHaveLength(0);
	expect(windowRows()).toBe(before);
	expect(h.inference.state.cancelled).toEqual(["req-1"]);
});

test("a thrown error inside one operation is a refusal of that operation, not of the settle", async () => {
	const h = await setup();
	await h.say("user", "毎朝コーヒーを飲んでる");
	const original = h.continuity.addByAgentInTransaction;
	h.continuity.addByAgentInTransaction = () => {
		throw new Error("boom");
	};
	h.inference.state.script = (data) =>
		answer(
			{ type: "note_add", turn: labelOf(data), kind: "memo", text: "壊れる" },
			{
				type: "remember",
				turn: labelOf(data),
				requested: false,
				kind: "habit",
				semanticKey: "morning.coffee",
				text: "毎朝コーヒーを飲む",
				quote: "毎朝コーヒーを飲んでる",
			},
		);
	await h.schedule();
	await h.settled();
	h.continuity.addByAgentInTransaction = original;
	expect(h.memory.list()).toHaveLength(1);
	expect(h.cursor()).toBeGreaterThan(0);
	expect(h.failures()).toBe(0);
});

const pauseBriefly = () => new Promise((resolve) => setTimeout(resolve, 100));
