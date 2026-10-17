import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../../../infrastructure/logger";
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
async function exchange(h: MemoryHarness, user: string, answer: string | null) {
	const runId = `run-w${++runs}`;
	const inputMessageId = await h.say("user", user, "c1", runId);
	const answerMessageId =
		answer === null ? null : await h.say("assistant", answer, "c1", runId);
	await h.store.write((db) =>
		h.memory.recordExchangeInTransaction(db, {
			conversationId: "c1",
			runId,
			inputMessageId,
			answerMessageId,
			outcome: answerMessageId === null ? "failed" : "answered",
		}),
	);
	return { inputMessageId, answerMessageId };
}
const publish = (
	h: MemoryHarness,
	opts: Parameters<
		MemoryHarness["memory"]["publishWindowInTransaction"]
	>[2] = {},
) => h.store.write((db) => h.memory.publishWindowInTransaction(db, "c1", opts));
const verbatim = (h: MemoryHarness) =>
	h.store.write((db) => {
		const window = h.memory.windowForRunInTransaction(db, "c1")!;
		const { keep, unprocessed } = h.memory.verbatimHistoryInTransaction(
			db,
			"c1",
			window,
		);
		return {
			keep: keep.map((ref) => ref.inputMessageId),
			unprocessed: unprocessed.map((ref) => ref.inputMessageId),
		};
	});
const dispose = (
	h: MemoryHarness,
	id: string,
	disposition: "keep" | "summarize" | "drop",
) =>
	h.store.write((db) => {
		h.memory.setDispositionInTransaction(db, id, disposition);
		h.memory.markExchangeStepInTransaction(db, id, "curated", "done");
		h.memory.markExchangeStepInTransaction(db, id, "disposed", "done");
	});

test("the first publish builds the window with an empty history; the layers keep their text", async () => {
	const h = await setup();
	const window = await publish(h);
	expect(window.history).toEqual({
		keep: [],
		summaryText: "",
		summaryRevision: 0,
	});
});

test("kept exchanges are appended in order and stay where they are when later ones are kept", async () => {
	const h = await setup();
	const a = await exchange(h, "最初の質問", "最初の答え");
	const b = await exchange(h, "二番目の質問", "二番目の答え");
	const c = await exchange(h, "三番目の質問", "三番目の答え");
	await dispose(h, b.inputMessageId, "keep");
	const first = await publish(h);
	expect(first.history.keep.map((ref) => ref.inputMessageId)).toEqual([
		b.inputMessageId,
	]);
	// A later verdict on an older exchange appends: the published order is not rewritten.
	await dispose(h, c.inputMessageId, "keep");
	await publish(h);
	await dispose(h, a.inputMessageId, "keep");
	const second = await publish(h);
	expect(second.history.keep.map((ref) => ref.inputMessageId)).toEqual([
		b.inputMessageId,
		c.inputMessageId,
		a.inputMessageId,
	]);
	expect(second.history.keep[0]).toEqual({
		inputMessageId: b.inputMessageId,
		answerMessageId: b.answerMessageId,
	});
});

test("section 2.3: an exchange leaves the verbatim history only when its verdict is carried out", async () => {
	const h = await setup();
	const undecided = await exchange(h, "未判断の質問", "答え");
	const kept = await exchange(h, "残す質問", "答え");
	const dropped = await exchange(h, "捨てる質問", "答え");
	const waiting = await exchange(h, "要約待ちの質問", "答え");
	const summarized = await exchange(h, "要約済みの質問", "答え");
	const skipped = await exchange(h, "要約を諦めた質問", "答え");
	await dispose(h, kept.inputMessageId, "keep");
	await dispose(h, dropped.inputMessageId, "drop");
	await dispose(h, waiting.inputMessageId, "summarize");
	await dispose(h, summarized.inputMessageId, "summarize");
	await dispose(h, skipped.inputMessageId, "summarize");
	await h.store.write((db) => {
		const result = h.memory.writeSummaryInTransaction(db, {
			conversationId: "c1",
			text: "要約済みの質問について話した。",
			included: [summarized.inputMessageId],
			expectedRevision: 0,
		});
		expect(result.ok).toBe(true);
		h.memory.markExchangeStepInTransaction(
			db,
			skipped.inputMessageId,
			"summarized",
			"skipped",
		);
	});
	await publish(h);
	const { keep, unprocessed } = await verbatim(h);
	// summarized and not skipped: verbatim until the summary holds it; skipped: kept verbatim.
	expect(keep).toEqual([kept.inputMessageId, skipped.inputMessageId]);
	expect(unprocessed).toEqual([
		undecided.inputMessageId,
		waiting.inputMessageId,
	]);
	const window = await publish(h);
	expect(window.history.summaryText).toBe("要約済みの質問について話した。");
	expect(window.history.summaryRevision).toBe(1);
});

test("a blocked exchange is in neither layer nor the summary", async () => {
	const h = await setup();
	const a = await exchange(h, "忘れる質問", "忘れる答え");
	const b = await exchange(h, "残す質問", "残す答え");
	await dispose(h, a.inputMessageId, "keep");
	await dispose(h, b.inputMessageId, "keep");
	await h.store.write((db) => {
		h.memory.writeSummaryInTransaction(db, {
			conversationId: "c1",
			text: "忘れる質問の要約",
			included: [a.inputMessageId],
			expectedRevision: 0,
		});
		h.memory.setDispositionInTransaction(db, a.inputMessageId, "keep");
	});
	await publish(h);
	await h.forget([], [a.inputMessageId]);
	const window = await publish(h);
	expect(window.history.keep.map((ref) => ref.inputMessageId)).toEqual([
		b.inputMessageId,
	]);
	expect(window.history.summaryText).toBe("");
	const { keep, unprocessed } = await verbatim(h);
	expect(keep).toEqual([b.inputMessageId]);
	expect(unprocessed).toEqual([]);
});

test("publishing does not expire a run in flight, and records no immediate change", async () => {
	const h = await setup();
	await h.seed("コーヒーが好き", "food.coffee");
	const window = await h.window();
	const prepared = h.memory.preparedWindow(window);
	const a = await exchange(h, "質問", "答え");
	await dispose(h, a.inputMessageId, "keep");
	await h.seed("毎朝走っている", "habit.run", "毎朝走って", "habit");
	const published = await publish(h, { addNotices: ["お知らせ"] });
	expect(published.version).toBeGreaterThan(window.version);
	expect(published.notices.map((notice) => notice.text)).toEqual(["お知らせ"]);
	const verdict = await h.store.write((db) =>
		h.memory.validateWindowInTransaction(db, "run-in-flight", prepared),
	);
	expect(verdict).toEqual({ ok: true });
});

test("L1 is republished only when asked or for an immediate change, a policy change or a crossed boundary", async () => {
	const h = await setup();
	const item = await h.seed("コーヒーが好き", "food.coffee");
	const base = await publish(h);
	await h.seed("毎朝走っている", "habit.run", "毎朝走って", "habit");
	const quiet = await publish(h);
	expect(quiet.longTerm.text).toBe(base.longTerm.text);
	expect(quiet.shortTerm.text).toContain("毎朝走っている");
	// Another day does not change L1 either.
	h.time.now = "2026-10-20T12:00:00.000Z";
	expect((await publish(h)).longTerm.text).toBe(base.longTerm.text);
	// A stop is an immediate change: the next publish renders L1 again.
	await h.stop(item.id, item.revision);
	const stopped = await publish(h);
	expect(stopped.longTerm.text).not.toContain("コーヒーが好き");
	expect(stopped.longTerm.text).toContain("毎朝走っている");
});

const day = (n: number) =>
	`2026-10-${String(n).padStart(2, "0")}T09:00:00.000Z`;

test("the summary records the range of the exchanges it stands on, from the ledger", async () => {
	const h = await setup();
	h.time.now = day(1);
	const a = await exchange(h, "一日目の質問", "答え");
	h.time.now = day(2);
	const b = await exchange(h, "二日目の質問", "答え");
	h.time.now = day(5);
	const c = await exchange(h, "五日目の質問", "答え");
	for (const x of [a, b, c]) await dispose(h, x.inputMessageId, "summarize");
	await h.store.write((db) =>
		h.memory.writeSummaryInTransaction(db, {
			conversationId: "c1",
			text: "一日目と二日目の話。",
			included: [a.inputMessageId, b.inputMessageId],
			expectedRevision: 0,
		}),
	);
	const window = await publish(h);
	expect(window.history.summaryText).toBe("一日目と二日目の話。");
	expect(window.history.summaryCovers).toEqual({
		fromAt: day(1),
		toAt: day(2),
		turns: 2,
	});
	// The next revision stands on the earlier sources too.
	await h.store.write((db) =>
		h.memory.writeSummaryInTransaction(db, {
			conversationId: "c1",
			text: "五日目までの話。",
			included: [c.inputMessageId],
			expectedRevision: 1,
		}),
	);
	expect((await publish(h)).history.summaryCovers).toEqual({
		fromAt: day(1),
		toAt: day(5),
		turns: 3,
	});
});

test("a summary on a blocked exchange has no text and no range", async () => {
	const h = await setup();
	const a = await exchange(h, "忘れる質問", "忘れる答え");
	await dispose(h, a.inputMessageId, "summarize");
	await h.store.write((db) =>
		h.memory.writeSummaryInTransaction(db, {
			conversationId: "c1",
			text: "忘れる質問の要約",
			included: [a.inputMessageId],
			expectedRevision: 0,
		}),
	);
	expect((await publish(h)).history.summaryCovers).toBeDefined();
	await h.forget([], [a.inputMessageId]);
	const window = await publish(h);
	expect(window.history.summaryText).toBe("");
	expect(window.history.summaryCovers).toBeUndefined();
});
