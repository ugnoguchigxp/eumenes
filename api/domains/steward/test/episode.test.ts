import { afterEach, expect, test } from "bun:test";
import {
	planWindow,
	type WindowPlan,
} from "../../../infrastructure/context-budget";
import { episodeTokens } from "../../continuity";
import { moveRange } from "../service/episode-plan";
import { setupSteward, type StewardHarness } from "./steward.fixture";

const harnesses: StewardHarness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.close();
});

/** A window whose log, episode and work results are small enough for a few exchanges to be over them. */
const smallPlan = (episode = 300): WindowPlan => {
	const base = planWindow({ window: 262_144, fixed: 3000 });
	return {
		...base,
		sections: { ...base.sections, episode, active: 200 },
		log: { cap: 400, high: 200, low: 100, keep: 40 },
	};
};
async function setup(plan: () => WindowPlan = smallPlan) {
	const h = await setupSteward({ windowPlan: plan });
	harnesses.push(h);
	return h;
}
const empty = { remember: [], update: [], stop: [], notes: [], resolve: [] };
const say = (n: number) => `${"あ".repeat(40)}${n}`;
/** `count` exchanges three minutes apart (a break in the talk between each), the way a conversation grows. */
async function talk(h: StewardHarness, count: number, from = 0) {
	const ids: Array<{ inputMessageId: string; answerMessageId: string | null }> =
		[];
	for (let i = 0; i < count; i++) {
		h.time.ms += 180_000;
		ids.push(await h.exchange(say(from + i), say(from + i)));
	}
	return ids;
}
const summarizing = (summary = "古い話をした。") => ({ summary });

test("the oldest events the next re-construction moves are summarized, and the summary is prepared, not shown", async () => {
	const h = await setup();
	h.inference.script("curate-memory", ...Array(6).fill(empty));
	h.inference.script("summarize", summarizing());
	// Two events a run: the log goes over its target while the steward is busy; nothing waits for a model.
	await talk(h, 4);
	await h.pump(30);
	const calls = h.inference.callsOf("summarize");
	expect(calls).toHaveLength(1);
	const events = calls[0]!.data.events as Array<{ id: string; by: string }>;
	// Only the oldest events that the cut leaves out: the newest ones stay in the log.
	expect(events.length).toBeGreaterThan(0);
	expect(events.length).toBeLessThan(8);
	expect(events[0]).toMatchObject({ id: "e1", by: "user" });
	const prepared = h.episode("prepared");
	expect(prepared).toHaveLength(1);
	expect(prepared[0]).toMatchObject({
		kind: "summary",
		fromSeq: 1,
		text: "古い話をした。",
		count: events.length,
	});
	expect(prepared[0]!.toSeq).toBe(events.length);
	// The summary stands on the messages of the events it summarized (a forget of one makes it a mark).
	expect(prepared[0]!.messageIds).toHaveLength(events.length);
	expect(h.episode("shown")).toEqual([]);
	const decision = h.steward
		.decisions("c1")
		.find((d) => d.step === "summarize")!;
	expect(decision.windowVersionAfter).toBeNull();
});

test("an idle re-construction applies the prepared summary: quiet for ten seconds, no answer being generated", async () => {
	const h = await setup();
	h.inference.script("curate-memory", ...Array(6).fill(empty));
	h.inference.script("summarize", summarizing());
	await talk(h, 4);
	await h.pump(30);
	const before = h.log().length;
	expect(h.episode("prepared")).toHaveLength(1);
	// The last event is not ten seconds old: nothing moves.
	const last = Math.max(...h.log().map((e) => Date.parse(e.at)));
	h.time.ms = last + 9_000;
	await h.kick("c1");
	expect(h.log()).toHaveLength(before);
	expect(h.timerTimes().length).toBeGreaterThan(0);
	// An answer being generated holds it back too.
	h.time.ms = last + 20_000;
	h.foreground.add("c1");
	await h.kick("c1");
	expect(h.log()).toHaveLength(before);
	h.foreground.delete("c1");
	await h.kick("c1");
	const shown = h.episode("shown");
	expect(shown).toHaveLength(1);
	expect(shown[0]).toMatchObject({
		kind: "summary",
		text: "古い話をした。",
		fromSeq: 1,
	});
	expect(h.log().length).toBeLessThan(before);
	// The summary covers exactly the events that left the log.
	expect(shown[0]!.count).toBe(before - h.log().length);
	expect(h.episode("prepared")).toEqual([]);
	expect(
		h.store.read((db) =>
			h.continuity.events.windowVersionInTransaction(db, "c1"),
		),
	).toMatchObject({ reason: "log_over_target" });
	const tokens = h.log().reduce((sum, e) => sum + e.tokens, 0);
	expect(tokens).toBeLessThanOrEqual(100);
});

test("without a summary the re-construction does not wait: the range becomes an unsummarized mark", async () => {
	const h = await setup();
	h.inference.script("curate-memory", ...Array(6).fill(empty));
	h.inference.script("summarize", "bad", "bad", "bad");
	await talk(h, 4);
	await h.drain();
	// (The range grows with the log, so each range has its own tries.)
	const summarizeStates = h
		.units()
		.filter((u) => u.step === "summarize")
		.map((u) => u.state);
	expect(summarizeStates.length).toBeGreaterThanOrEqual(3);
	expect(new Set(summarizeStates)).toEqual(new Set(["failed"]));
	// A range that failed is not waited for: the log still fits its limit.
	const shown = h.episode("shown");
	expect(shown[0]).toMatchObject({
		kind: "unsummarized",
		text: "",
		fromSeq: 1,
	});
	expect(h.log().reduce((sum, e) => sum + e.tokens, 0)).toBeLessThanOrEqual(
		100,
	);
});

test("an unsummarized mark is summarized from the messages and the summary takes its place at the next re-construction", async () => {
	const h = await setup();
	// While memory is off nothing is summarized: the first re-construction leaves a mark.
	await h.memory.setEnabled(false);
	await talk(h, 4);
	await h.drain();
	const shown = h.episode("shown");
	expect(shown).toHaveLength(1);
	expect(shown[0]).toMatchObject({ kind: "unsummarized", fromSeq: 1 });
	await h.memory.setEnabled(true);
	// The moved events keep no text: the summary is made from their messages.
	h.inference.script("summarize", (data) => {
		const events = data.events as Array<{ by: string; text: string }>;
		expect(events[0]).toMatchObject({ by: "user", text: say(0) });
		return summarizing("印の範囲の要約");
	});
	await h.kick("c1");
	await h.drain();
	const prepared = h.episode("prepared");
	expect(prepared).toHaveLength(1);
	expect(prepared[0]).toMatchObject({
		kind: "summary",
		text: "印の範囲の要約",
		fromSeq: shown[0]!.fromSeq,
		toSeq: shown[0]!.toSeq,
	});
	// Nothing re-constructs for the mark alone: it waits for the next re-construction.
	expect(h.episode("shown")[0]).toMatchObject({ kind: "unsummarized" });
	await talk(h, 4, 10);
	h.inference.script("curate-memory", ...Array(6).fill(empty));
	h.inference.script("summarize", summarizing("次の範囲"));
	await h.drain();
	const parts = h.episode("shown");
	expect(parts[0]).toMatchObject({ kind: "summary", text: "印の範囲の要約" });
});

test("the re-construction needs no memory: with memory off the log is still kept within its limit, without a model", async () => {
	const h = await setup();
	await h.memory.setEnabled(false);
	await talk(h, 4);
	await h.drain();
	expect(h.inference.calls).toEqual([]);
	expect(h.episode("shown")[0]).toMatchObject({ kind: "unsummarized" });
	expect(h.log().reduce((sum, e) => sum + e.tokens, 0)).toBeLessThanOrEqual(
		100,
	);
});

test("a re-construction between prepare and settle makes the preparation stale, and it is made again", async () => {
	const h = await setup();
	h.inference.script("curate-memory", ...Array(6).fill(empty));
	h.inference.script(
		"summarize",
		async () => {
			await h.store.write((db) =>
				h.continuity.events.bumpWindowInTransaction(
					db,
					"c1",
					new Date(h.time.ms).toISOString(),
					"immediate_change",
				),
			);
			return summarizing("古い土台の要約");
		},
		summarizing("新しい土台の要約"),
	);
	await talk(h, 4);
	await h.pump(40);
	const stale = h.steward
		.decisions("c1")
		.find((d) => d.errorCode === "stale_window")!;
	expect(stale).toMatchObject({ step: "summarize", output: null });
	const prepared = h.episode("prepared");
	expect(prepared).toHaveLength(1);
	expect(prepared[0]!.text).toBe("新しい土台の要約");
});

test("a forget between prepare and settle makes the preparation stale, and a forgotten message turns a prepared summary into a mark", async () => {
	const h = await setup();
	h.inference.script("curate-memory", ...Array(6).fill(empty));
	h.inference.script("summarize", summarizing("忘れる前の要約"));
	const ids = await talk(h, 4);
	await h.pump(30);
	expect(h.episode("prepared")).toHaveLength(1);
	await h.memory.forget({
		conversationId: "c1",
		itemIds: [],
		messageIds: [ids[0]!.inputMessageId],
	});
	// The summary stood on the forgotten message: it is a range mark now, with no text.
	expect(h.episode("prepared")[0]).toMatchObject({
		kind: "unsummarized",
		text: "",
	});
	expect(JSON.stringify(h.episode("prepared"))).not.toContain("忘れる前の要約");
});

test("shown parts near the episode limit are merged into one prepared summary that spans them exactly, and a re-construction applies it", async () => {
	const h = await setup(() => smallPlan(200));
	const part = (from: number, to: number, text: string) => ({
		kind: "summary" as const,
		fromSeq: from,
		toSeq: to,
		fromAt: "2026-10-14T10:00:00.000Z",
		toAt: "2026-10-14T10:30:00.000Z",
		count: to - from + 1,
		text,
		messageIds: [`m${from}`],
	});
	const parts = [
		part(1, 10, "あ".repeat(60)),
		part(11, 20, "い".repeat(60)),
		part(21, 30, "う".repeat(60)),
	];
	await h.store.write((db) =>
		h.continuity.events.writeEpisodeInTransaction(db, "c1", "shown", parts),
	);
	expect(episodeTokens(parts)).toBeGreaterThan(200);
	h.inference.script("refine-summary", (data) => {
		const shown = data.parts as Array<{
			id: string;
			kind: string;
			text: string;
		}>;
		expect(shown.map((p) => p.kind)).toEqual(["summary", "summary", "summary"]);
		return summarizing("まとめた要約");
	});
	await h.kick("c1");
	await h.pump(20);
	const decision = h.steward
		.decisions("c1")
		.find((d) => d.step === "refine-summary")!;
	expect(decision.results).toMatchObject([
		{ status: "applied", from: 1, to: 30, count: 30 },
	]);
	// The episode is over its limit and nothing is generating or was said lately: the re-construction right
	// after the preparation applies the merge, and the prepared episode is used up.
	expect(h.episode("shown")).toMatchObject([
		{
			kind: "summary",
			fromSeq: 1,
			toSeq: 30,
			count: 30,
			text: "まとめた要約",
			messageIds: ["m1", "m11", "m21"],
		},
	]);
	expect(h.episode("prepared")).toEqual([]);
	expect(
		h.store.read((db) =>
			h.continuity.events.windowVersionInTransaction(db, "c1"),
		),
	).toMatchObject({ reason: "section_over_limit" });
});

test("a merge that is not shorter than what it replaces is not used", async () => {
	const h = await setup(() => smallPlan(200));
	const part = (from: number, to: number) => ({
		kind: "summary" as const,
		fromSeq: from,
		toSeq: to,
		fromAt: "2026-10-14T10:00:00.000Z",
		toAt: "2026-10-14T10:30:00.000Z",
		count: 1,
		text: "あ".repeat(60),
		messageIds: [],
	});
	await h.store.write((db) =>
		h.continuity.events.writeEpisodeInTransaction(db, "c1", "shown", [
			part(1, 10),
			part(11, 20),
			part(21, 30),
		]),
	);
	const long = { summary: "あ".repeat(400) };
	h.inference.script("refine-summary", long, long, long);
	await h.kick("c1");
	await h.drain();
	expect(h.episode("prepared")).toEqual([]);
	// A failure pauses the next try and the re-construction waits for it; only the third failure gives the range up.
	expect(
		h
			.units()
			.filter((u) => u.step === "refine-summary")
			.map((u) => u.state),
	).toEqual(["failed", "failed", "failed"]);
	// The re-construction then brings the episode within its limit, without a model.
	expect(episodeTokens(h.episode("shown"))).toBeLessThanOrEqual(200);
});

test("the re-construction asks memory to publish the profile anew when the steward requested it", async () => {
	const h = await setup();
	h.inference.script("curate-memory", ...Array(6).fill(empty));
	h.inference.script("summarize", summarizing());
	await h.store.write((db) => {
		h.memory.windowForRunInTransaction(db, "c1");
		h.memory.publishWindowInTransaction(db, "c1", { requestRepublish: true });
	});
	expect(
		h.store.read((db) => h.memory.windows.storedInTransaction(db, "c1"))!
			.republishRequested,
	).toBe(true);
	await talk(h, 4);
	await h.drain();
	expect(h.episode("shown")).toHaveLength(1);
	expect(
		h.store.read((db) => h.memory.windows.storedInTransaction(db, "c1"))!
			.republishRequested,
	).toBe(false);
});

test("the re-construction waits while the next try of a failed summary is paused, instead of dropping the summary", async () => {
	const h = await setup();
	h.inference.script("curate-memory", ...Array(6).fill(empty));
	h.inference.script("summarize", "bad", summarizing());
	await talk(h, 4);
	const summaries = () => h.units().filter((u) => u.step === "summarize");
	for (let i = 0; i < 60 && !summaries().some((u) => u.state === "failed"); i++)
		await h.pump(1);
	expect(summaries().some((u) => u.state === "failed")).toBe(true);
	// The failed try paused the next one for 15 s; the talk was quiet for 12 s, which would be enough to rebuild.
	const last = Math.max(...h.log().map((e) => Date.parse(e.at)));
	h.time.ms = last + 12_000;
	const before = h.log().length;
	await h.kick("c1");
	expect(summaries().every((u) => u.state !== "open")).toBe(true);
	expect(h.log()).toHaveLength(before);
	expect(h.episode("shown")).toEqual([]);
	// The retry then succeeds and the re-construction applies the summary.
	await h.drain();
	expect(h.episode("shown")[0]).toMatchObject({
		kind: "summary",
		text: "古い話をした。",
	});
});

test("the re-construction also publishes the profile when additions wait in newMemories", async () => {
	const h = await setup();
	h.inference.script("curate-memory", ...Array(6).fill(empty));
	h.inference.script("summarize", summarizing());
	await h.store.write((db) => h.memory.windowForRunInTransaction(db, "c1"));
	const ids = await talk(h, 4);
	await h.store.write((db) =>
		h.memory.applyCurationInTransaction(db, {
			conversationId: "c1",
			items: [
				{
					op: "remember",
					kind: "preference",
					key: "waiting",
					text: "待っている記憶",
					negated: false,
					messageId: ids[0]!.inputMessageId,
					quote: null,
					explicit: true,
				},
			],
		}),
	);
	await h.store.write((db) => h.memory.windowForRunInTransaction(db, "c1"));
	const waiting = () =>
		h.store.read((db) => h.memory.windows.storedInTransaction(db, "c1"))!;
	expect(waiting().newMemories.map((item) => item.text)).toEqual([
		"待っている記憶",
	]);
	expect(waiting().republishRequested).toBe(false);
	await h.drain();
	expect(h.episode("shown")).toHaveLength(1);
	expect(waiting().newMemories).toEqual([]);
	expect(waiting().profile.items.map((item) => item.text)).toEqual([
		"待っている記憶",
	]);
});

test("finished work results over their limit leave at the re-construction; a question stays", async () => {
	const h = await setup();
	await h.store.write((db) => {
		h.continuity.events.putActiveInTransaction(db, {
			conversationId: "c1",
			todoId: "todo-ask",
			status: "waiting",
			at: "2026-10-14T10:00:00.000Z",
			fields: { question: "q".repeat(300) },
		});
		h.continuity.events.putActiveInTransaction(db, {
			conversationId: "c1",
			todoId: "todo-done",
			status: "done",
			at: "2026-10-14T10:01:00.000Z",
			fields: { result: "r".repeat(1200) },
		});
		h.continuity.events.appendInTransaction(db, {
			conversationId: "c1",
			at: new Date(h.time.ms).toISOString(),
			type: "notice",
			by: "host",
			fields: { text: "x" },
		});
	});
	h.time.ms += 20_000;
	await h.kick("c1");
	expect(
		h.store
			.read((db) => h.continuity.events.activeInTransaction(db, "c1"))
			.map((slot) => slot.todoId),
	).toEqual(["todo-ask"]);
});

test("a log that is within its target is left alone, however long the quiet", async () => {
	const h = await setup();
	h.inference.script("curate-memory", empty);
	await talk(h, 1);
	h.time.ms += 3_600_000;
	await h.drain();
	expect(h.inference.callsOf("summarize")).toHaveLength(0);
	expect(h.episode("shown")).toEqual([]);
	expect(
		h.store.read((db) =>
			h.continuity.events.windowVersionInTransaction(db, "c1"),
		).version,
	).toBe(0);
});

test("the range the next re-construction moves: the latest break in the talk, whole in seq order", () => {
	const event = (seq: number, at: string, tokens = 50) =>
		({ seq, at, tokens }) as never;
	const log = [
		event(1, "2026-10-14T10:00:00.000Z"),
		event(2, "2026-10-14T10:00:10.000Z"),
		event(3, "2026-10-14T10:10:00.000Z"),
		event(4, "2026-10-14T10:10:10.000Z"),
		event(5, "2026-10-14T10:10:20.000Z"),
	];
	const targets = { cap: 400, high: 200, low: 150, keep: 50 };
	// 250 tokens over a high of 200: down to 150 leaves three events, and the break is before the third.
	expect(moveRange(log, targets)).toEqual({ cut: 2, fromSeq: 1, toSeq: 2 });
	// Within the target: nothing to move.
	expect(moveRange(log, { ...targets, high: 300 })).toBeNull();
	// A user utterance handled late sits after newer events and keeps its own seq: a cut through it is not made.
	const late = [
		event(2, "2026-10-14T10:00:00.000Z"),
		event(3, "2026-10-14T10:00:10.000Z"),
		event(1, "2026-10-14T10:00:20.000Z"),
		event(4, "2026-10-14T10:00:30.000Z"),
		event(5, "2026-10-14T10:00:40.000Z"),
	];
	const range = moveRange(late, targets)!;
	expect(late.slice(0, range.cut).map((e: { seq: number }) => e.seq)).toEqual([
		2, 3, 1,
	]);
	expect(range.toSeq).toBe(3);
});
