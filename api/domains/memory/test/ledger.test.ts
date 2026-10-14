import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../../../infrastructure/logger";
import { SUMMARY_MAX_CHARS } from "../service/ledger";
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
let runs = 0;
async function exchange(
	h: MemoryHarness,
	user: string,
	answer: string | null,
	conversationId = "c1",
) {
	const runId = `run-x${++runs}`;
	const inputMessageId = await h.say("user", user, conversationId, runId);
	const answerMessageId =
		answer === null
			? null
			: await h.say("assistant", answer, conversationId, runId);
	const registered = await h.store.write((db) =>
		h.memory.recordExchangeInTransaction(db, {
			conversationId,
			runId,
			inputMessageId,
			answerMessageId,
			outcome: answerMessageId === null ? "failed" : "answered",
		}),
	);
	return { runId, inputMessageId, answerMessageId, registered };
}
const write = <T>(h: MemoryHarness, fn: (db: never) => T) =>
	h.store.write(fn as never) as Promise<T>;
const pending = (
	h: MemoryHarness,
	step: "curated" | "disposed" | "summarized",
) =>
	h.store.read((db) =>
		h.memory
			.pendingExchangesInTransaction(db, "c1", step, 10)
			.map((row) => row.inputMessageId),
	);

test("a run's exchange is registered once, with its ordinals and the outcome; a failed run has no answer", async () => {
	const h = await setup();
	const first = await exchange(h, "こんにちは", "どうも");
	expect(first.registered).toEqual({ registered: true });
	const failed = await exchange(h, "予算は3万円以内", null);
	const rows = h.memory.exchanges("c1");
	expect(rows.map((r) => r.inputMessageId)).toEqual([
		first.inputMessageId,
		failed.inputMessageId,
	]);
	expect(rows[0]).toMatchObject({
		answerMessageId: first.answerMessageId,
		outcome: "answered",
		state: "pending",
		curated: null,
		disposed: null,
		summarized: null,
		disposition: null,
		duplicateOf: null,
		failures: {},
		runId: first.runId,
	});
	expect(rows[0]!.answerOrdinal).toBe(rows[0]!.inputOrdinal + 1);
	expect(rows[1]).toMatchObject({
		outcome: "failed",
		answerMessageId: null,
		answerOrdinal: null,
	});
	// Registering again changes nothing.
	const again = await h.store.write((db) =>
		h.memory.recordExchangeInTransaction(db, {
			conversationId: "c1",
			runId: first.runId,
			inputMessageId: first.inputMessageId,
			answerMessageId: first.answerMessageId,
			outcome: "answered",
		}),
	);
	expect(again).toEqual({ registered: false });
	expect(h.memory.exchanges("c1")).toHaveLength(2);
});

test("a malformed exchange is refused: an assistant input, a user answer, another conversation, an outcome that disagrees", async () => {
	const h = await setup();
	const user = await h.say("user", "質問");
	const answer = await h.say("assistant", "回答");
	const foreign = await h.say("assistant", "別の会話の回答", "c2");
	const record = (over: object) =>
		h.store.write((db) =>
			h.memory.recordExchangeInTransaction(db, {
				conversationId: "c1",
				runId: "r",
				inputMessageId: user,
				answerMessageId: answer,
				outcome: "answered",
				...over,
			}),
		);
	await expect(record({ inputMessageId: answer })).rejects.toThrow(
		"invalid_exchange",
	);
	await expect(record({ answerMessageId: user })).rejects.toThrow(
		"invalid_exchange",
	);
	await expect(record({ answerMessageId: foreign })).rejects.toThrow(
		"invalid_exchange",
	);
	await expect(record({ outcome: "failed" })).rejects.toThrow(
		"invalid_exchange",
	);
	await expect(record({ answerMessageId: null })).rejects.toThrow(
		"invalid_exchange",
	);
	await expect(record({ inputMessageId: "ghost" })).rejects.toThrow(
		"invalid_exchange",
	);
	expect(h.memory.exchanges("c1")).toEqual([]);
});

test("a scheduled prompt is blocked, not registered, and never offered", async () => {
	const h = await setup();
	const runId = "run-sched";
	const prompt = await h.say("user", "定期の問い合わせ", "c1", runId);
	await h.store.write((db) =>
		h.memory.blockMessagesInTransaction(db, {
			conversationId: "c1",
			messageIds: [prompt],
			reason: "scheduled_prompt",
		}),
	);
	const answer = await h.say("assistant", "定期の回答", "c1", runId);
	const registered = await h.store.write((db) =>
		h.memory.recordExchangeInTransaction(db, {
			conversationId: "c1",
			runId,
			inputMessageId: prompt,
			answerMessageId: answer,
			outcome: "answered",
		}),
	);
	expect(registered).toEqual({ registered: false });
	expect(h.memory.exchanges("c1")).toEqual([]);
	expect(h.memory.blockedMessageIds([prompt, answer])).toEqual(
		new Set([prompt]),
	);
	const ok = await exchange(h, "普通の質問", "普通の回答");
	// Blocking afterwards (a forget) takes an exchange out of every step's queue.
	await h.store.write((db) =>
		h.memory.blockMessagesInTransaction(db, {
			conversationId: "c1",
			messageIds: [ok.answerMessageId!],
			reason: "scheduled_prompt",
		}),
	);
	expect(pending(h, "curated")).toEqual([]);
});

test("each step has its own queue; an exchange is done only when all three steps are marked", async () => {
	const h = await setup();
	const a = await exchange(h, "一つ目", "回答1");
	const b = await exchange(h, "二つ目", "回答2");
	expect(pending(h, "curated")).toEqual([a.inputMessageId, b.inputMessageId]);
	expect(
		await h.store.read((db) =>
			h.memory
				.pendingExchangesInTransaction(db, "c1", "curated", 1)
				.map((r) => r.inputMessageId),
		),
	).toEqual([a.inputMessageId]);
	const mark = (
		id: string,
		step: "curated" | "disposed" | "summarized",
		m: "done" | "skipped",
	) =>
		h.store.write((db) =>
			h.memory.markExchangeStepInTransaction(db, id, step, m),
		);
	expect(await mark(a.inputMessageId, "curated", "done")).toBe(true);
	expect(await mark("ghost", "curated", "done")).toBe(false);
	expect(pending(h, "curated")).toEqual([b.inputMessageId]);
	expect(pending(h, "disposed")).toEqual([a.inputMessageId, b.inputMessageId]);
	// Nothing waits for the summarize step before the dispose step decided to summarize.
	expect(pending(h, "summarized")).toEqual([]);
	await mark(a.inputMessageId, "disposed", "done");
	await h.store.write((db) =>
		h.memory.setDispositionInTransaction(db, a.inputMessageId, "summarize"),
	);
	expect(pending(h, "summarized")).toEqual([a.inputMessageId]);
	const row = () => h.memory.exchanges("c1")[0]!;
	expect(row().state).toBe("pending");
	await mark(a.inputMessageId, "summarized", "skipped");
	expect(row()).toMatchObject({
		state: "done",
		summarized: "skipped",
		disposition: "summarize",
	});
	expect(pending(h, "summarized")).toEqual([]);
	// keep and drop close the summarize step themselves.
	await mark(b.inputMessageId, "curated", "skipped");
	await mark(b.inputMessageId, "disposed", "done");
	await h.store.write((db) =>
		h.memory.setDispositionInTransaction(
			db,
			b.inputMessageId,
			"drop",
			a.inputMessageId,
		),
	);
	expect(h.memory.exchanges("c1")[1]).toMatchObject({
		state: "done",
		disposition: "drop",
		duplicateOf: a.inputMessageId,
		summarized: "done",
	});
});

test("failed attempts of a step are counted per step", async () => {
	const h = await setup();
	const a = await exchange(h, "質問", "回答");
	const fail = (step: "curated" | "disposed" | "summarized") =>
		h.store.write((db) =>
			h.memory.recordExchangeFailureInTransaction(db, a.inputMessageId, step),
		);
	expect(await fail("curated")).toBe(1);
	expect(await fail("curated")).toBe(2);
	expect(await fail("disposed")).toBe(1);
	expect(h.memory.exchanges("c1")[0]!.failures).toEqual({
		curated: 2,
		disposed: 1,
	});
	expect(
		await h.store.write((db) =>
			h.memory.recordExchangeFailureInTransaction(db, "ghost", "curated"),
		),
	).toBe(0);
});

test("a summary keeps the sources of the earlier revision and adds the new ones; a rewrite on an older revision is refused", async () => {
	const h = await setup();
	const a = await exchange(h, "一つ目", "回答1");
	const b = await exchange(h, "二つ目", "回答2");
	const c = await exchange(h, "三つ目", "回答3");
	const other = await exchange(h, "別の会話", "回答", "c2");
	const summarize = (
		text: string,
		included: string[],
		expectedRevision: number,
	) =>
		h.store.write((db) =>
			h.memory.writeSummaryInTransaction(db, {
				conversationId: "c1",
				text,
				included,
				expectedRevision,
			}),
		);
	expect(
		h.store.read((db) => h.memory.summaryInTransaction(db, "c1")),
	).toBeNull();
	const first = await summarize(
		"要約1",
		[a.inputMessageId, b.inputMessageId, other.inputMessageId],
		0,
	);
	// An exchange of another conversation is not a source of this summary.
	expect(first).toMatchObject({ ok: true, revision: 1 });
	if (!first.ok) throw new Error("refused");
	expect(first.sources.sort()).toEqual(
		[a.inputMessageId, b.inputMessageId].sort(),
	);
	expect(
		h.memory.exchanges("c1").map((r) => [r.disposition, r.summarized]),
	).toEqual([
		["summarize", "done"],
		["summarize", "done"],
		[null, null],
	]);
	expect(await summarize("古い土台", [c.inputMessageId], 0)).toEqual({
		ok: false,
		reason: "stale_revision",
	});
	const second = await summarize("要約2", [c.inputMessageId], 1);
	if (!second.ok) throw new Error("refused");
	expect(second.revision).toBe(2);
	const stored = h.store.read((db) => h.memory.summaryInTransaction(db, "c1"));
	expect(stored).toMatchObject({ text: "要約2", revision: 2 });
	expect(stored!.sources.sort()).toEqual(
		[a.inputMessageId, b.inputMessageId, c.inputMessageId].sort(),
	);
	// Older revisions' source rows are gone.
	expect(
		h.store.read(
			(db) =>
				(
					db
						.query(
							"SELECT COUNT(*) AS n FROM memory_summary_source WHERE revision < 2",
						)
						.get() as { n: number }
				).n,
		),
	).toBe(0);
	// A rewrite with nothing new (refine) still carries every source.
	const refined = await summarize("短い要約", [], 2);
	if (!refined.ok) throw new Error("refused");
	expect(refined.sources).toHaveLength(3);
	// Compacting history folds exchanges that were kept.
	const d = await exchange(h, "四つ目", "回答4");
	await h.store.write((db) =>
		h.memory.setDispositionInTransaction(db, d.inputMessageId, "keep"),
	);
	await summarize("畳んだ要約", [d.inputMessageId], 3);
	expect(h.memory.exchanges("c1")[3]).toMatchObject({
		disposition: "summarize",
		summarized: "done",
	});
	// Empty and over-long texts are refused.
	expect(await summarize("  ", [], 4)).toEqual({
		ok: false,
		reason: "invalid_summary",
	});
	expect(await summarize("あ".repeat(SUMMARY_MAX_CHARS + 1), [], 4)).toEqual({
		ok: false,
		reason: "invalid_summary",
	});
	expect(await summarize("あ".repeat(SUMMARY_MAX_CHARS), [], 4)).toMatchObject({
		ok: true,
	});
});

test("blocked exchanges leave a rewritten summary's sources", async () => {
	const h = await setup();
	const a = await exchange(h, "一つ目", "回答1");
	const b = await exchange(h, "二つ目", "回答2");
	await write(h, (db: never) =>
		h.memory.writeSummaryInTransaction(db, {
			conversationId: "c1",
			text: "要約",
			included: [a.inputMessageId, b.inputMessageId],
			expectedRevision: 0,
		}),
	);
	await h.store.write((db) =>
		h.memory.blockMessagesInTransaction(db, {
			conversationId: "c1",
			messageIds: [a.inputMessageId],
			reason: "scheduled_prompt",
		}),
	);
	const next = await h.store.write((db) =>
		h.memory.writeSummaryInTransaction(db, {
			conversationId: "c1",
			text: "書き直し",
			included: [a.inputMessageId],
			expectedRevision: 1,
		}),
	);
	if (!next.ok) throw new Error("refused");
	expect(next.sources).toEqual([b.inputMessageId]);
});

test("what is said while memory is off is registered as skipped; switching on skips what was still waiting", async () => {
	const h = await setup();
	const before = await exchange(h, "オフにする前", "回答");
	await h.memory.setEnabled(false);
	const during = await exchange(h, "オフの間", "回答");
	void during;
	const rows = h.memory.exchanges("c1");
	expect(rows[1]).toMatchObject({
		state: "done",
		curated: "skipped",
		disposed: "skipped",
		summarized: "skipped",
		disposition: null,
	});
	expect(rows[0]).toMatchObject({ state: "pending", curated: null });
	await h.memory.setEnabled(true);
	expect(h.memory.exchanges("c1")[0]).toMatchObject({
		inputMessageId: before.inputMessageId,
		state: "done",
		curated: "skipped",
	});
	const after = await exchange(h, "オンの後", "回答");
	expect(pending(h, "curated")).toEqual([after.inputMessageId]);
});

test("the forget fence moves with a forget and with every start-up reconciliation, never otherwise", async () => {
	const h = await setup();
	const seq = () => h.store.read((db) => h.memory.forgetSeqInTransaction(db));
	// The reconciliation of the fixture's start-up already moved it once.
	const start = seq();
	expect(start).toBe(1);
	const item = await h.seed("コーヒーが好き", "drink.coffee");
	await exchange(h, "質問", "回答");
	expect(seq()).toBe(start);
	await h.forget([item.id]);
	expect(seq()).toBe(start + 1);
	await h.memory.recover();
	expect(seq()).toBe(start + 2);
});
