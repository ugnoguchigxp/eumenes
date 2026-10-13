import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../../../infrastructure/logger";
import type { AgentOp } from "../service/agent-schema";
import type {
	AgentOpResult,
	AgentReason,
	AgentRefs,
	AgentTurn,
} from "../service/operation";
import { setupMemory, type MemoryHarness } from "./memory.fixture";

const open: MemoryHarness[] = [];
afterEach(async () => {
	configureLogging({ level: "silent" });
	for (const h of open.splice(0)) await h.close();
});
async function setup() {
	const h = await setupMemory();
	open.push(h);
	return h;
}
const turnFor = (
	label: string,
	messageId: string,
	role: "user" | "assistant",
	text: string,
	runId: string | null,
): AgentTurn => ({
	label,
	messageId,
	runId,
	role,
	text,
	createdAt: "2026-10-13T12:00:00.000Z",
});
async function apply(
	h: MemoryHarness,
	ctx: { refs?: AgentRefs; turns: AgentTurn[] },
	op: AgentOp,
) {
	return h.store.write((db) =>
		h.memory.applyAgentOpInTransaction(
			db,
			{ conversationId: "c1", refs: ctx.refs ?? {}, turns: ctx.turns },
			op,
		),
	);
}
const immediate = (h: MemoryHarness) =>
	h.store.read(
		(db) =>
			db
				.query(
					"SELECT kind, source_run_id AS runId FROM memory_immediate_change ORDER BY seq",
				)
				.all() as Array<{ kind: string; runId: string | null }>,
	);
const remember = (over: Partial<AgentOp> = {}): AgentOp => ({
	type: "remember",
	turn: "u1",
	requested: false,
	kind: "habit",
	semanticKey: "run.morning",
	text: "毎朝5時に起きて走る",
	quote: "毎朝5時に起きて走って",
	...over,
});

test("a quote with different spacing and width is cut from the message and stored as the literal words", async () => {
	const h = await setup();
	const id = await h.say("user", "毎朝　５時に起きて走ってる。", "c1", "run-a");
	const turns = [
		turnFor("u1", id, "user", "毎朝　５時に起きて走ってる。", "run-a"),
	];
	expect(await apply(h, { turns }, remember())).toEqual({ status: "applied" });
	expect(h.memory.list()[0]).toMatchObject({
		evidence: [{ messageId: id, quote: "毎朝　５時に起きて走って" }],
		capturedBy: "agent",
	});
	// A new State item is an addition: nothing immediate is recorded.
	expect(await immediate(h)).toEqual([]);
});

test("the period is stored with its precision", async () => {
	const h = await setup();
	const id = await h.say("user", "9月からZedを使ってる", "c1", "run-a");
	const turns = [turnFor("u1", id, "user", "9月からZedを使ってる", "run-a")];
	expect(
		await apply(
			h,
			{ turns },
			remember({
				kind: "habit",
				semanticKey: "editor",
				text: "Zedを使っている",
				quote: "Zedを使ってる",
				validFrom: "2026-09",
			}),
		),
	).toEqual({ status: "applied" });
	expect(h.memory.list()[0]?.validity).toEqual({ from: "2026-09" });
	// An impossible date is a refusal, with nothing left behind.
	expect(
		await apply(
			h,
			{ turns },
			remember({
				semanticKey: "editor2",
				text: "Zedを使う",
				quote: "Zedを使ってる",
				validFrom: "2026-13",
			}),
		),
	).toEqual({ status: "rejected", reason: "invalid_input" });
	expect(h.memory.list()).toHaveLength(1);
});

test("State is written only from the user's turns, with a state kind and a real quote", async () => {
	const h = await setup();
	const user = await h.say("user", "毎朝5時に起きて走ってる", "c1", "run-a");
	const assistant = await h.say("assistant", "毎朝5時に起きて走ってるんですね");
	const turns = [
		turnFor("u1", user, "user", "毎朝5時に起きて走ってる", "run-a"),
		turnFor(
			"a1",
			assistant,
			"assistant",
			"毎朝5時に起きて走ってるんですね",
			null,
		),
	];
	const refused = (reason: AgentReason): AgentOpResult => ({
		status: "rejected",
		reason,
	});
	expect(await apply(h, { turns }, remember({ turn: "a1" }))).toEqual(
		refused("invalid_input"),
	);
	expect(await apply(h, { turns }, remember({ turn: "u9" }))).toEqual(
		refused("invalid_input"),
	);
	expect(await apply(h, { turns }, remember({ kind: "memo" }))).toEqual(
		refused("invalid_input"),
	);
	expect(
		await apply(h, { turns }, remember({ quote: "毎朝4時に起きて" })),
	).toEqual(refused("quote_mismatch"));
	expect(h.memory.list()).toHaveLength(0);
});

test("update: needs the item at the revision the agent saw; a replaced value is an immediate change by that turn's run", async () => {
	const h = await setup();
	const item = await h.seed("コーヒーが好き", "drink.coffee");
	const id = await h.say(
		"user",
		"さっきの好み、紅茶に訂正して",
		"c1",
		"run-fix",
	);
	const turns = [
		turnFor("u1", id, "user", "さっきの好み、紅茶に訂正して", "run-fix"),
	];
	const refs: AgentRefs = {
		m1: { namespace: "state", id: item.id, revision: item.revision },
	};
	const update = (over: Partial<AgentOp> = {}): AgentOp => ({
		type: "update",
		turn: "u1",
		requested: true,
		ref: "m1",
		text: "紅茶が好き",
		quote: "紅茶に訂正",
		...over,
	});
	// Wrong namespace and unknown refs.
	expect(await apply(h, { turns, refs }, update({ ref: "n1" }))).toEqual({
		status: "rejected",
		reason: "unknown_ref",
	});
	// The item moved on since the agent looked.
	expect(
		await apply(
			h,
			{
				turns,
				refs: { m1: { namespace: "state", id: item.id, revision: 99 } },
			},
			update(),
		),
	).toEqual({ status: "rejected", reason: "item_changed" });
	expect(await apply(h, { turns, refs }, update())).toEqual({
		status: "applied",
	});
	const items = h.memory.list(true);
	expect(items.find((i) => i.status === "active")).toMatchObject({
		text: "紅茶が好き",
		capturedBy: "request",
	});
	expect(await immediate(h)).toEqual([
		{ kind: "state_replace", runId: "run-fix" },
	]);
	// The same ref again: the item it named has been superseded.
	expect(await apply(h, { turns, refs }, update())).toEqual({
		status: "rejected",
		reason: "item_changed",
	});
});

test("stop: only on request, at the seen revision, recorded as the turn's run", async () => {
	const h = await setup();
	const item = await h.seed("コーヒーが好き", "drink.coffee");
	const id = await h.say("user", "それはもう使わないで", "c1", "run-stop");
	const turns = [turnFor("u1", id, "user", "それはもう使わないで", "run-stop")];
	const refs: AgentRefs = {
		m1: { namespace: "state", id: item.id, revision: item.revision },
	};
	const stop = (over: Partial<AgentOp> = {}): AgentOp => ({
		type: "stop",
		turn: "u1",
		requested: true,
		ref: "m1",
		...over,
	});
	expect(await apply(h, { turns, refs }, stop({ requested: false }))).toEqual({
		status: "rejected",
		reason: "invalid_input",
	});
	expect(
		await apply(
			h,
			{ turns, refs: { m1: { ...refs.m1!, revision: 7 } } },
			stop(),
		),
	).toEqual({ status: "rejected", reason: "item_changed" });
	expect(await apply(h, { turns, refs }, stop())).toEqual({
		status: "applied",
	});
	expect(h.memory.list(true)[0]?.status).toBe("inactive");
	expect(await immediate(h)).toEqual([
		{ kind: "state_stop", runId: "run-stop" },
	]);
});

test("notes: the user's or the assistant's words, kinds checked, refs resolved by revision", async () => {
	const h = await setup();
	const user = await h.say("user", "移行を進める", "c1", "run-a");
	const assistant = await h.say("assistant", "まず調査から始めましょう");
	const turns = [
		turnFor("u1", user, "user", "移行を進める", "run-a"),
		turnFor("a1", assistant, "assistant", "まず調査から始めましょう", null),
	];
	expect(
		await apply(
			h,
			{ turns },
			{
				type: "note_add",
				turn: "a1",
				kind: "decision",
				text: "まず調査から始める",
			},
		),
	).toEqual({ status: "applied" });
	expect(h.continuity.list("c1")[0]).toMatchObject({
		origin: "agent",
		sourceMessageId: assistant,
		kind: "decision",
	});
	// A State kind is not a note.
	expect(
		await apply(
			h,
			{ turns },
			{
				type: "note_add",
				turn: "u1",
				kind: "habit",
				text: "x",
			},
		),
	).toEqual({ status: "rejected", reason: "invalid_input" });
	const note = h.continuity.list("c1")[0]!;
	const refs: AgentRefs = {
		n1: { namespace: "continuity", id: note.id, revision: note.revision },
	};
	expect(
		await apply(
			h,
			{ turns, refs },
			{ type: "note_update", ref: "n1", text: "調査から着手" },
		),
	).toEqual({ status: "applied" });
	// The same ref is now stale.
	expect(
		await apply(
			h,
			{ turns, refs },
			{ type: "note_update", ref: "n1", text: "再度" },
		),
	).toEqual({ status: "rejected", reason: "item_changed" });
	expect(
		await apply(
			h,
			{ turns, refs },
			{ type: "note_close", ref: "n1", status: "resolved" },
		),
	).toEqual({ status: "rejected", reason: "item_changed" });
	expect(
		await apply(
			h,
			{
				turns,
				refs: { n1: { ...refs.n1!, revision: note.revision + 1 } },
			},
			{ type: "note_close", ref: "n1", status: "retracted" },
		),
	).toEqual({ status: "applied" });
	expect(h.continuity.list("c1")).toHaveLength(0);
});

test("the short-term byte budget refuses an addition and leaves no row behind", async () => {
	const h = await setup();
	const id = await h.say("user", "メモ", "c1", "run-a");
	const turns = [turnFor("u1", id, "user", "メモ", "run-a")];
	const long = "あ".repeat(490);
	let refused = 0;
	for (let i = 0; i < 30; i++) {
		const result = await apply(
			h,
			{ turns },
			{
				type: "note_add",
				turn: "u1",
				kind: "memo",
				text: `${i}:${long}`,
			},
		);
		if (result.status === "rejected") {
			expect(result.reason).toBe("limit_reached");
			refused++;
		}
	}
	expect(refused).toBeGreaterThan(0);
	const kept = h.continuity.list("c1").length;
	expect(kept).toBeLessThan(30);
	// 8 KiB at 3 bytes a character.
	expect(kept).toBeLessThanOrEqual(6);
});

test("tendencies: text length, distinct live evidence, the cap of twenty, update and retire by revision", async () => {
	const h = await setup();
	const a = await h.seed("コーヒーが好き", "drink.coffee");
	const b = await h.seed("毎朝走る", "run", "毎朝走る", "habit");
	const refs: AgentRefs = {
		m1: { namespace: "state", id: a.id, revision: a.revision },
		m2: { namespace: "state", id: b.id, revision: b.revision },
	};
	const add = (text: string, evidenceRefs = ["m1", "m2"]): AgentOp => ({
		type: "tendency_add",
		text,
		evidenceRefs,
	});
	expect(await apply(h, { turns: [], refs }, add("あ".repeat(121)))).toEqual({
		status: "rejected",
		reason: "invalid_input",
	});
	expect(
		await apply(h, { turns: [], refs }, add("朝型", ["m1", "m1"])),
	).toEqual({
		status: "rejected",
		reason: "invalid_input",
	});
	expect(await apply(h, { turns: [], refs }, add("朝型"))).toEqual({
		status: "applied",
	});
	const [tendency] = h.memory.tendencies();
	expect(tendency).toMatchObject({ text: "朝型", revision: 1 });
	const tRefs: AgentRefs = {
		...refs,
		t1: { namespace: "tendency", id: tendency!.id, revision: 1 },
	};
	expect(
		await apply(
			h,
			{ turns: [], refs: tRefs },
			{
				type: "tendency_update",
				ref: "t1",
				text: "朝型で運動好き",
				evidenceRefs: ["m1", "m2"],
			},
		),
	).toEqual({ status: "applied" });
	expect(h.memory.tendencies()[0]).toMatchObject({
		text: "朝型で運動好き",
		revision: 2,
	});
	expect(
		await apply(
			h,
			{ turns: [], refs: tRefs },
			{ type: "tendency_retire", ref: "t1" },
		),
	).toEqual({ status: "rejected", reason: "item_changed" });
	// Retiring takes it out of the active list.
	expect(
		await apply(
			h,
			{
				turns: [],
				refs: { ...tRefs, t1: { ...tRefs.t1!, revision: 2 } },
			},
			{ type: "tendency_retire", ref: "t1" },
		),
	).toEqual({ status: "applied" });
	expect(h.memory.tendencies()).toEqual([]);
	for (let i = 0; i < 20; i++)
		expect(await apply(h, { turns: [], refs }, add(`傾向${i}`))).toEqual({
			status: "applied",
		});
	expect(await apply(h, { turns: [], refs }, add("あふれる"))).toEqual({
		status: "rejected",
		reason: "limit_reached",
	});
});

test("tendency evidence must still be live: a stopped item or a closed note no longer counts", async () => {
	const h = await setup();
	const a = await h.seed("コーヒーが好き", "drink.coffee");
	const b = await h.seed("毎朝走る", "run", "毎朝走る", "habit");
	await h.memory.stop(b.id, b.revision);
	const refs: AgentRefs = {
		m1: { namespace: "state", id: a.id, revision: a.revision },
		m2: { namespace: "state", id: b.id, revision: b.revision },
	};
	expect(
		await apply(
			h,
			{ turns: [], refs },
			{
				type: "tendency_add",
				text: "朝型",
				evidenceRefs: ["m1", "m2"],
			},
		),
	).toEqual({ status: "rejected", reason: "invalid_input" });
	expect(h.memory.tendencies()).toEqual([]);
});

test("a tendency the user deletes is gone, and the layer is rebuilt", async () => {
	const h = await setup();
	const a = await h.seed("コーヒーが好き", "drink.coffee");
	const b = await h.seed("毎朝走る", "run", "毎朝走る", "habit");
	const refs: AgentRefs = {
		m1: { namespace: "state", id: a.id, revision: a.revision },
		m2: { namespace: "state", id: b.id, revision: b.revision },
	};
	await apply(
		h,
		{ turns: [], refs },
		{
			type: "tendency_add",
			text: "朝型",
			evidenceRefs: ["m1", "m2"],
		},
	);
	const before = await h.window();
	const prepared = h.memory.preparedWindow(before);
	const [tendency] = h.memory.tendencies();
	expect(await h.memory.deleteTendency(tendency!.id)).toEqual({ ok: true });
	expect(h.memory.tendencies()).toEqual([]);
	// The rendered windows are dropped with it.
	expect(
		h.store.read(
			(db) =>
				(
					db.query("SELECT COUNT(*) AS n FROM memory_context_window").get() as {
						n: number;
					}
				).n,
		),
	).toBe(0);
	await expect(h.memory.deleteTendency(tendency!.id)).rejects.toThrow(
		"invalid_memory_item",
	);
	expect((await immediate(h)).at(-1)).toEqual({
		kind: "tendency_delete",
		runId: null,
	});
	expect(
		await h.store.write((db) =>
			h.memory.validateWindowInTransaction(db, "run-x", prepared),
		),
	).toEqual({ ok: false, reason: "memory_stale" });
});

test("a quote must be real evidence: long enough and related to the fact written from it", async () => {
	const h = await setup();
	const id = await h.say(
		"user",
		"ありがとう。ところで、私は毎朝コーヒーを飲んでいます。",
		"c1",
		"run-a",
	);
	const turns = [
		turnFor(
			"u1",
			id,
			"user",
			"ありがとう。ところで、私は毎朝コーヒーを飲んでいます。",
			"run-a",
		),
	];
	const refused: AgentOpResult = {
		status: "rejected",
		reason: "quote_mismatch",
	};
	// One character cannot evidence a fact.
	expect(
		await apply(h, { turns }, remember({ quote: "私", text: "私は毎朝走る" })),
	).toEqual(refused);
	// A real sentence of the message, but nothing to do with the fact claimed (a pretext).
	expect(
		await apply(
			h,
			{ turns },
			remember({
				quote: "ありがとう",
				text: "辛いものが好き",
				semanticKey: "food",
			}),
		),
	).toEqual(refused);
	expect(h.memory.list()).toHaveLength(0);
	// Width and case do not matter for the overlap.
	expect(
		await apply(
			h,
			{ turns },
			remember({
				quote: "毎朝コーヒーを飲んで",
				text: "毎朝ｺｰﾋｰ",
				semanticKey: "coffee",
			}),
		),
	).toEqual({ status: "applied" });
});

test("a message marked as excluded can neither be quoted nor noted", async () => {
	const h = await setup();
	const id = await h.say("user", "私は辛いものが好きです", "c1", "run-sched");
	await h.store.write((db) => h.memory.excludeMessageInTransaction(db, id));
	const turns = [
		turnFor("u1", id, "user", "私は辛いものが好きです", "run-sched"),
	];
	expect(
		await apply(
			h,
			{ turns },
			remember({
				quote: "辛いものが好き",
				text: "辛いものが好き",
				semanticKey: "food",
			}),
		),
	).toEqual({ status: "rejected", reason: "invalid_input" });
	expect(
		await apply(
			h,
			{ turns },
			{ type: "note_add", turn: "u1", kind: "memo", text: "辛い" },
		),
	).toEqual({ status: "rejected", reason: "invalid_input" });
	expect(h.memory.list()).toHaveLength(0);
	expect(h.continuity.list("c1")).toHaveLength(0);
});

test("D8: neither a stopped nor a retracted item is written again unless the user asked", async () => {
	const h = await setup();
	const retracted = await h.seed("コーヒーが好き", "drink.coffee");
	await h.memory.retract(retracted.id, retracted.revision);
	const id = await h.say("user", "コーヒーが好きだよ", "c1", "run-a");
	const turns = [turnFor("u1", id, "user", "コーヒーが好きだよ", "run-a")];
	const write = (requested: boolean) =>
		remember({
			requested,
			kind: "preference",
			semanticKey: "drink.coffee",
			text: "コーヒーが好き",
			quote: "コーヒーが好き",
		});
	expect(await apply(h, { turns }, write(false))).toEqual({
		status: "rejected",
		reason: "user_stopped",
	});
	expect(h.memory.list()).toHaveLength(0);
	expect(await apply(h, { turns }, write(true))).toEqual({ status: "applied" });
	expect(h.memory.list()).toMatchObject([{ capturedBy: "request" }]);
});

test("origin follows who asked: an unrequested write is agent_inferred, a requested one user_confirmed", async () => {
	const h = await setup();
	const id = await h.say("user", "毎朝5時に起きて走ってる", "c1", "run-a");
	const turns = [turnFor("u1", id, "user", "毎朝5時に起きて走ってる", "run-a")];
	expect(await apply(h, { turns }, remember())).toEqual({ status: "applied" });
	expect(
		await apply(
			h,
			{ turns },
			remember({
				requested: true,
				kind: "preference",
				semanticKey: "run.pace",
				text: "毎朝5時に起きて走る",
				quote: "毎朝5時に起きて走って",
			}),
		),
	).toEqual({ status: "applied" });
	const items = h.memory.list();
	expect(items.find((i) => i.semanticKey === "run.morning")).toMatchObject({
		origin: "agent_inferred",
		capturedBy: "agent",
	});
	expect(items.find((i) => i.semanticKey === "run.pace")).toMatchObject({
		origin: "user_confirmed",
		capturedBy: "request",
	});
	// Registering through the API is the user's own word.
	expect(await h.seed("コーヒーが好き", "drink.coffee")).toMatchObject({
		origin: "user_confirmed",
	});
});

test("a later explicit request replaces an agent_inferred item and takes over the origin", async () => {
	const h = await setup();
	const first = await h.say("user", "毎朝5時に起きて走ってる", "c1", "run-a");
	const second = await h.say(
		"user",
		"いや、毎朝6時に起きて走ることにした",
		"c1",
		"run-b",
	);
	const turns = [
		turnFor("u1", first, "user", "毎朝5時に起きて走ってる", "run-a"),
		turnFor(
			"u2",
			second,
			"user",
			"いや、毎朝6時に起きて走ることにした",
			"run-b",
		),
	];
	await apply(h, { turns }, remember());
	expect(
		await apply(
			h,
			{ turns },
			remember({
				turn: "u2",
				requested: true,
				text: "毎朝6時に起きて走る",
				quote: "毎朝6時に起きて走る",
			}),
		),
	).toEqual({ status: "applied" });
	const all = h.memory.list(true);
	expect(all.filter((i) => i.status === "active")).toMatchObject([
		{
			text: "毎朝6時に起きて走る",
			origin: "user_confirmed",
			capturedBy: "request",
		},
	]);
	expect(all.find((i) => i.status === "superseded")).toMatchObject({
		origin: "agent_inferred",
	});
	// The value changed: an immediate change, by the run of that turn.
	expect(await immediate(h)).toEqual([
		{ kind: "state_replace", runId: "run-b" },
	]);
});

test("the same words asked for later promote an agent_inferred item without a new version", async () => {
	const h = await setup();
	const id = await h.say("user", "毎朝5時に起きて走ってる", "c1", "run-a");
	const turns = [turnFor("u1", id, "user", "毎朝5時に起きて走ってる", "run-a")];
	await apply(h, { turns }, remember());
	const before = h.memory.list()[0];
	expect(await apply(h, { turns }, remember({ requested: true }))).toEqual({
		status: "applied",
	});
	const after = h.memory.list(true);
	expect(after).toHaveLength(1);
	expect(after[0]).toMatchObject({
		id: before?.id,
		origin: "user_confirmed",
		revision: (before?.revision ?? 0) + 1,
		capturedBy: "request",
	});
	// An unrequested write of the same words never takes the origin back.
	await apply(h, { turns }, remember());
	expect(h.memory.list()[0]?.origin).toBe("user_confirmed");
});

test("D8 also holds for an agent_inferred item the user stopped, and a request brings it back as user_confirmed", async () => {
	const h = await setup();
	const id = await h.say("user", "毎朝5時に起きて走ってる", "c1", "run-a");
	const turns = [turnFor("u1", id, "user", "毎朝5時に起きて走ってる", "run-a")];
	await apply(h, { turns }, remember());
	const item = h.memory.list()[0];
	if (!item) throw new Error("setup");
	await h.memory.stop(item.id, item.revision);
	expect(await apply(h, { turns }, remember())).toEqual({
		status: "rejected",
		reason: "user_stopped",
	});
	expect(h.memory.list()).toHaveLength(0);
	expect(await apply(h, { turns }, remember({ requested: true }))).toEqual({
		status: "applied",
	});
	expect(h.memory.list()).toMatchObject([
		{ origin: "user_confirmed", capturedBy: "request" },
	]);
});

test("a write that changes nothing leaves who asked for the item alone", async () => {
	const h = await setup();
	const id = await h.say("user", "毎朝5時に起きて走ってる", "c1", "run-a");
	const turns = [turnFor("u1", id, "user", "毎朝5時に起きて走ってる", "run-a")];
	await apply(h, { turns }, remember({ requested: true }));
	expect(h.memory.list()[0]?.capturedBy).toBe("request");
	// The agent concludes the same thing again on its own: nothing changes, so the item stays "asked for".
	expect(await apply(h, { turns }, remember())).toEqual({ status: "applied" });
	expect(h.memory.list()).toMatchObject([
		{ capturedBy: "request", origin: "user_confirmed", revision: 1 },
	]);
	// An agent item stays the agent's until something actually changes it.
	await apply(
		h,
		{ turns },
		remember({ semanticKey: "run.other", text: "毎朝5時に走る" }),
	);
	await apply(
		h,
		{ turns },
		remember({ semanticKey: "run.other", text: "毎朝5時に走る" }),
	);
	expect(
		h.memory.list().find((i) => i.semanticKey === "run.other"),
	).toMatchObject({
		capturedBy: "agent",
		origin: "agent_inferred",
		revision: 1,
	});
	// The promotion by an explicit request is a change: it becomes "request".
	await apply(
		h,
		{ turns },
		remember({
			semanticKey: "run.other",
			text: "毎朝5時に走る",
			requested: true,
		}),
	);
	expect(
		h.memory.list().find((i) => i.semanticKey === "run.other"),
	).toMatchObject({
		capturedBy: "request",
		origin: "user_confirmed",
		revision: 2,
	});
});

test("an inference never replaces what the user confirmed, by remember or by update; the same value is not a disagreement", async () => {
	const h = await setup();
	const item = await h.seed(
		"毎朝5時に起きて走る",
		"run.morning",
		undefined,
		"habit",
	);
	const id = await h.say(
		"user",
		"毎朝5時に起きて走ってる。最近は夜に走ってる",
		"c1",
		"run-a",
	);
	const turns = [
		turnFor(
			"u1",
			id,
			"user",
			"毎朝5時に起きて走ってる。最近は夜に走ってる",
			"run-a",
		),
	];
	const refs: AgentRefs = {
		m1: { namespace: "state", id: item.id, revision: item.revision },
	};
	const protectedResult: AgentOpResult = {
		status: "rejected",
		reason: "user_protected",
		protectedText: "毎朝5時に起きて走る",
	};
	// remember with another value
	expect(
		await apply(
			h,
			{ turns },
			remember({ text: "夜に走る", quote: "夜に走ってる" }),
		),
	).toEqual(protectedResult);
	// update of the item it names
	expect(
		await apply(
			h,
			{ turns, refs },
			{
				type: "update",
				turn: "u1",
				requested: false,
				ref: "m1",
				text: "夜に走る",
				quote: "夜に走ってる",
			},
		),
	).toEqual(protectedResult);
	// a different polarity is a disagreement too
	expect(
		await apply(
			h,
			{ turns },
			remember({ polarity: "negated", quote: "毎朝5時に起きて走って" }),
		),
	).toEqual(protectedResult);
	expect(h.memory.list(true)).toMatchObject([
		{
			id: item.id,
			text: "毎朝5時に起きて走る",
			origin: "user_confirmed",
			revision: 1,
		},
	]);
	expect(await immediate(h)).toEqual([]);
	// The same value is the unchanged path: nothing moves, the user's provenance stays.
	expect(await apply(h, { turns }, remember())).toEqual({ status: "applied" });
	expect(h.memory.list(true)).toMatchObject([
		{
			id: item.id,
			origin: "user_confirmed",
			revision: 1,
			capturedBy: "manual",
		},
	]);
	// A request still replaces it.
	expect(
		await apply(
			h,
			{ turns },
			remember({ requested: true, text: "夜に走る", quote: "夜に走ってる" }),
		),
	).toEqual({ status: "applied" });
	expect(h.memory.list()).toMatchObject([
		{ text: "夜に走る", origin: "user_confirmed", capturedBy: "request" },
	]);
});

test("an agent_inferred item is replaced by a later inference (it has no user protection)", async () => {
	const h = await setup();
	const id = await h.say(
		"user",
		"毎朝5時に起きて走ってる。最近は夜に走ってる",
		"c1",
		"run-a",
	);
	const turns = [
		turnFor(
			"u1",
			id,
			"user",
			"毎朝5時に起きて走ってる。最近は夜に走ってる",
			"run-a",
		),
	];
	await apply(h, { turns }, remember());
	expect(
		await apply(
			h,
			{ turns },
			remember({ text: "夜に走る", quote: "夜に走ってる" }),
		),
	).toEqual({ status: "applied" });
	expect(h.memory.list()).toMatchObject([
		{ text: "夜に走る", origin: "agent_inferred" },
	]);
});

test("registering through the API takes over who asked: a promoted agent item reads as manual", async () => {
	const h = await setup();
	const id = await h.say("user", "毎朝5時に起きて走ってる", "c1", "run-a");
	const turns = [turnFor("u1", id, "user", "毎朝5時に起きて走ってる", "run-a")];
	await apply(h, { turns }, remember());
	expect(h.memory.list()[0]).toMatchObject({
		origin: "agent_inferred",
		capturedBy: "agent",
	});
	const promoted = await h.memory.remember({
		conversationId: "c1",
		messageId: id,
		quote: "毎朝5時に起きて走って",
		kind: "habit",
		semanticKey: "run.morning",
		text: "毎朝5時に起きて走る",
		polarity: "affirmed",
	});
	expect(promoted).toMatchObject({
		origin: "user_confirmed",
		capturedBy: "manual",
	});
	expect(h.memory.list()[0]).toMatchObject({
		origin: "user_confirmed",
		capturedBy: "manual",
	});
	// Repeating it changes nothing and keeps it.
	await h.memory.remember({
		conversationId: "c1",
		messageId: id,
		quote: "毎朝5時に起きて走って",
		kind: "habit",
		semanticKey: "run.morning",
		text: "毎朝5時に起きて走る",
		polarity: "affirmed",
	});
	expect(h.memory.list()[0]?.revision).toBe(promoted.revision);
});
