import { afterEach, expect, test } from "bun:test";
import { MAINTENANCE_QUIET_MS } from "../contracts";
import type { MemoryService } from "../../memory";
import {
	setupSteward,
	topicEmbed,
	type StewardHarness,
} from "./steward.fixture";

const harnesses: StewardHarness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.close();
});
async function setup(options: Parameters<typeof setupSteward>[0] = {}) {
	const h = await setupSteward({ embed: topicEmbed, ...options });
	harnesses.push(h);
	return h;
}
const empty = { remember: [], update: [], stop: [], notes: [], resolve: [] };
const item = (
	key: string,
	text: string,
	over: Record<string, unknown> = {},
) => ({
	kind: "preference",
	key,
	text,
	evidence: "e1",
	quote: null,
	validFrom: null,
	validUntil: null,
	negated: false,
	...over,
});
const resolve = (over: Record<string, unknown>) => ({
	request: "r1",
	action: "forget",
	refs: [],
	alsoIn: [],
	text: null,
	kind: null,
	key: null,
	...over,
});
const noticeTexts = (h: StewardHarness) => h.notices();
const jobOfUnit = (h: StewardHarness, unitId: string) =>
	h.store.read(
		(db) =>
			db
				.query(
					"SELECT id, attempt FROM queue_jobs WHERE json_extract(payload_json,'$.unitId') = ?",
				)
				.get(unitId) as { id: string; attempt: number },
	);
// ---- finding 2b / 7: a forget in the unit runs first and takes what stands on it ----

async function learn(h: StewardHarness, count = 1) {
	h.inference.script("curate-memory", {
		...empty,
		remember: Array.from({ length: count }, (_, i) =>
			item(`k.${i + 1}`, `住所に関する記憶${i + 1}`),
		),
	});
	const first = await h.run({
		user: "私の住所は東京都千代田区です",
		answer: "承知しました",
		end: "completed",
	});
	await h.drain();
	return first;
}

test("a forget runs first: what the same unit would save from the forgotten exchange is dropped", async () => {
	const h = await setup();
	await learn(h);
	h.inference.script("curate-memory", (data) => {
		const ref = (data.longTerm as Array<{ ref: string }>)[0]!.ref;
		return {
			...empty,
			remember: [item("address.again", "住所は東京都千代田区")],
			notes: [
				{ op: "add", ref: null, kind: "memo", text: "住所の話", status: null },
			],
			stop: [{ ref, why: "user_asked" }],
			resolve: [resolve({ refs: [ref], alsoIn: ["e1"] })],
		};
	});
	await h.run({
		user: "住所を忘れて",
		end: "completed",
		requests: [{ kind: "forget", what: "住所" }],
	});
	await h.drain();
	expect(h.memory.list().map((i) => i.semanticKey)).toEqual([]);
	const notes = h.store.read(
		(db) => h.continuity.snapshotInTransaction(db, "c1").items,
	);
	expect(notes).toEqual([]);
	const decision = h.steward
		.decisions("c1")
		.find((d) => d.step === "curate-memory" && d.errorCode === null)!;
	const results = decision.results as Array<Record<string, unknown>>;
	// The forget is the first thing applied; the rest is rejected for standing on it.
	expect(results[0]).toMatchObject({ section: "resolve", status: "applied" });
	expect(results.filter((r) => r.status === "rejected")).toEqual([
		{
			section: "remember",
			index: 0,
			status: "rejected",
			code: "blocked_source",
		},
		{ section: "stop", index: 0, status: "rejected", code: "unknown_item" },
		{ section: "notes", index: 0, status: "rejected", code: "blocked_source" },
	]);
	// The request's own exchange was one of the forgotten ones, but the forget succeeded: the request is done.
	expect(h.inbox()).toMatchObject([
		{ state: "done", resultCode: null, what: "" },
	]);
	expect(noticeTexts(h)).toContain("忘れる依頼を実行しました。");
});

test("a request that shares the forgotten message with a forget is ended by the purge without a failure notice", async () => {
	const h = await setup();
	await learn(h);
	h.inference.script("curate-memory", (data) => {
		const ref = (data.longTerm as Array<{ ref: string }>)[0]!.ref;
		// r2 is left unanswered: the purge has already ended it.
		return { ...empty, resolve: [resolve({ refs: [ref], alsoIn: ["e1"] })] };
	});
	await h.run({
		user: "住所を忘れて、あと覚えて",
		end: "completed",
		requests: [
			{ kind: "forget", what: "住所" },
			{ kind: "remember", what: "何か" },
		],
	});
	await h.drain();
	expect(h.inbox().map((r) => [r.kind, r.state, r.resultCode, r.what])).toEqual(
		[
			["forget", "done", null, ""],
			["remember", "none", "forgotten", ""],
		],
	);
	const notices = noticeTexts(h);
	expect(notices).toContain("忘れる依頼を実行しました。");
	expect(notices.some((t) => t.includes("実行できませんでした"))).toBe(false);
	expect(notices.some((t) => t.includes("処理できませんでした"))).toBe(false);
});

test("a ref the model was not shown ends the whole forget, and so does a list longer than five", async () => {
	const h = await setup();
	await learn(h, 6);
	expect(h.memory.list()).toHaveLength(6);
	h.inference.script("curate-memory", (data) => {
		const refs = (data.longTerm as Array<{ ref: string }>).map((e) => e.ref);
		return {
			...empty,
			resolve: [
				resolve({ request: "r1", refs: [refs[0], "m99"] }),
				resolve({ request: "r2", refs }),
			],
		};
	});
	await h.run({
		user: "全部忘れて",
		end: "completed",
		requests: [
			{ kind: "forget", what: "住所" },
			{ kind: "forget", what: "住所の記憶すべて" },
		],
	});
	await h.drain();
	expect(h.memory.list()).toHaveLength(6);
	expect(h.inbox().map((r) => [r.state, r.resultCode])).toEqual([
		["none", "unknown_ref"],
		["none", "forget_limit"],
	]);
	expect(noticeTexts(h)).toContain(
		"一度に忘れられる件数を超えているため、忘れる依頼を実行できませんでした。件数を減らしてもう一度お願いします。",
	);
});

test("five items can be forgotten at once", async () => {
	const h = await setup();
	await learn(h, 6);
	h.inference.script("curate-memory", (data) => {
		const refs = (data.longTerm as Array<{ ref: string }>)
			.map((e) => e.ref)
			.slice(0, 5);
		return { ...empty, resolve: [resolve({ refs })] };
	});
	await h.run({
		user: "五つ忘れて",
		end: "completed",
		requests: [{ kind: "forget", what: "住所の記憶" }],
	});
	await h.drain();
	// The six items share one evidence message. The forget blocks it, but only the five named items go:
	// the sixth is a fact the user did not ask to forget.
	expect(h.memory.list()).toHaveLength(1);
	expect(h.inbox()).toMatchObject([{ state: "done" }]);
});

test("a forget the memory refuses as too large ends the request without forgetting, and the rest of the unit goes on", async () => {
	const h = await setup({
		wrapMemory: (memory): MemoryService => ({
			...memory,
			forgetInTransaction() {
				throw new Error("forget_limit");
			},
		}),
	});
	await learn(h, 2);
	h.inference.script("curate-memory", (data) => {
		const ref = (data.longTerm as Array<{ ref: string }>)[0]!.ref;
		return {
			...empty,
			remember: [item("extra", "もう一つ")],
			resolve: [resolve({ refs: [ref] })],
		};
	});
	await h.run({
		user: "忘れて",
		end: "completed",
		requests: [{ kind: "forget", what: "住所の記憶" }],
	});
	await h.drain();
	expect(h.memory.list()).toHaveLength(3);
	expect(h.inbox()).toMatchObject([
		{ state: "none", resultCode: "forget_limit" },
	]);
	expect(noticeTexts(h).some((t) => t.includes("一度に忘れられる件数"))).toBe(
		true,
	);
});

// ---- finding 3: no job is enqueued for later ----

/** Upkeep runs only after a quiet spell: the clock moves past it, its timer fires and the queue runs. */
async function quietSpell(h: StewardHarness) {
	h.time.ms += MAINTENANCE_QUIET_MS;
	await h.fireTimer();
	await h.pump(12);
}

test("a deferred upkeep waits in the timer and never delays another conversation; a reflecting unit waits for the run to report", async () => {
	const h = await setup();
	h.inference.script("curate-memory", {
		...empty,
		remember: [item("a.one", "一つ目"), item("a.two", "二つ目")],
	});
	await h.run({ user: "二つ", end: "completed" });
	// Reflecting steps run once the run has reported; then a run is generating, and after the quiet spell the upkeep
	// unit is made, prepared, and deferred.
	await h.pump(12);
	h.foreground.add("c1");
	await quietSpell(h);
	const deferredAt = h.state()!.nextAt;
	expect(deferredAt).not.toBeNull();
	expect(deferredAt!).toBeGreaterThan(h.time.ms);
	expect(h.futureJobs()).toEqual([]);
	expect(h.timerTimes()).toContain(deferredAt!);
	expect(
		h.units().filter((u) => u.slot === "maintenance" && u.state === "open"),
	).toEqual([]);

	// Another conversation is curated now; this one's words wait for its run to report. The clock does not move.
	h.inference.script("curate-memory", empty, empty);
	await h.exchange("続き", "はい");
	await h.exchange("別", "はい", {
		conversationId: "c2",
	});
	const before = h.time.ms;
	await h.pump(16);
	expect(h.time.ms).toBe(before);
	expect(h.log("c2").every((e) => e.curated)).toBe(true);
	expect(h.log("c1").every((e) => e.curated)).toBe(false);
	// The run reports: its end kicks the steward, and the words are curated at once.
	h.foreground.clear();
	await h.kick();
	await h.pump(16);
	expect(h.time.ms).toBe(before);
	expect(h.log("c1").every((e) => e.curated)).toBe(true);
	expect(h.futureJobs()).toEqual([]);
	// The upkeep has not run: it is still waiting for its time.
	expect(
		h
			.units()
			.filter(
				(u) =>
					u.conversationId === "c1" &&
					u.step === "consolidate-memory" &&
					u.state === "open",
			),
	).toEqual([]);
	expect(h.state()!.nextAt).toBe(deferredAt);
});

test("the startup kick makes the upkeep that is due and waits for the one that is not", async () => {
	const h = await setup();
	h.inference.script("curate-memory", {
		...empty,
		remember: [item("a.one", "一つ目"), item("a.two", "二つ目")],
	});
	await h.run({ user: "二つ", end: "completed" });
	await h.pump(12);
	h.foreground.add("c1");
	await quietSpell(h);
	const dueAt = h.state()!.nextAt!;
	// A kick before the time makes no unit; the timer already waits for it.
	await h.kick();
	expect(
		h.units().filter((u) => u.slot === "maintenance" && u.state === "open"),
	).toEqual([]);
	expect(h.timerTimes()).toEqual([dueAt]);
	h.time.ms = dueAt;
	h.foreground.clear();
	h.inference.script("consolidate-memory", {
		merge: [],
		stop: [],
		tendencies: [],
		republishLongTerm: false,
		changed: false,
	});
	await h.kick();
	await h.drain();
	expect(h.inference.callsOf("consolidate-memory")).toHaveLength(1);
});

// ---- finding 4: the conversation route and the strict schema; the user is told ----

test("every step asks for the conversation's own route and a strict output schema", async () => {
	const h = await setup();
	h.inference.script("curate-memory", empty);
	await h.exchange("こんにちは", "どうも");
	await h.drain();
	expect(h.inference.captures.length).toBeGreaterThan(0);
	for (const input of h.inference.captures)
		expect(input).toMatchObject({
			route: "conversation",
			structuredOutput: true,
		});
});

test("a request given up after real failures is shown to the user as a notice", async () => {
	const h = await setup();
	const failure = new Error("provider_rejected");
	h.inference.script("curate-memory", failure, failure, failure);
	await h.run({
		user: "x",
		end: "completed",
		requests: [{ kind: "remember", what: "z" }],
	});
	await h.drain();
	expect(h.inbox()).toMatchObject([
		{ state: "none", resultCode: "steward_failed" },
	]);
	expect(noticeTexts(h)).toContain(
		"記憶の依頼を処理できませんでした。もう一度お願いします。",
	);
});

test("a request the model never answers is also announced", async () => {
	const h = await setup();
	h.inference.script("curate-memory", empty, empty, empty);
	await h.run({
		user: "x",
		end: "completed",
		requests: [{ kind: "remember", what: "z" }],
	});
	await h.drain();
	expect(h.inbox()).toMatchObject([
		{ state: "none", resultCode: "steward_failed" },
	]);
	expect(noticeTexts(h)).toContain(
		"記憶の依頼を処理できませんでした。もう一度お願いします。",
	);
});

// ---- finding 7: the notes' sources ----

test("a note is based on the messages of every event the unit read, and an update adds them", async () => {
	const h = await setup();
	const say = async (user: string, answer: string, runId: string) => {
		const inputMessageId = await h.say("user", user, "c1", runId);
		const answerMessageId = await h.say("assistant", answer, "c1", runId);
		return { runId, inputMessageId, answerMessageId };
	};
	const record = (
		db: Parameters<Parameters<typeof h.store.write>[0]>[0],
		e: Awaited<ReturnType<typeof say>>,
	) => h.recordSaid(db, "c1", e.inputMessageId, e.answerMessageId);
	const a = await say("目標は旅行", "了解", "run-a");
	const b = await say("行き先は沖縄", "了解", "run-b");
	await h.store.write((db) => {
		record(db, a);
		record(db, b);
		h.steward.runEndedInTransaction(db, {
			runId: a.runId,
			conversationId: "c1",
			state: "completed",
		});
	});
	h.inference.script("curate-memory", {
		...empty,
		notes: [
			{
				op: "add",
				ref: null,
				kind: "goal",
				text: "沖縄旅行を計画する",
				status: null,
			},
		],
	});
	await h.drain();
	const [note] = h.store.read(
		(db) => h.continuity.snapshotInTransaction(db, "c1").items,
	);
	expect(note!.sourceMessageIds.sort()).toEqual(
		[
			a.inputMessageId,
			a.answerMessageId,
			b.inputMessageId,
			b.answerMessageId,
		].sort(),
	);

	h.inference.script("curate-memory", (data) => {
		const ref = (data.shortTerm as Array<{ ref: string }>)[0]!.ref;
		return {
			...empty,
			notes: [
				{ op: "update", ref, kind: null, text: "夏に沖縄へ行く", status: null },
			],
		};
	});
	const c = await h.exchange("夏に行く", "了解");
	await h.drain();
	const [updated] = h.store.read(
		(db) => h.continuity.snapshotInTransaction(db, "c1").items,
	);
	expect(updated!.text).toBe("夏に沖縄へ行く");
	expect(updated!.sourceMessageIds).toEqual(
		expect.arrayContaining([
			a.inputMessageId,
			b.inputMessageId,
			c.inputMessageId,
		]),
	);
});

test("a note that repeats a live note is not added twice", async () => {
	const h = await setup();
	const note = (text: string) => ({
		...empty,
		notes: [{ op: "add", ref: null, kind: "activity", text, status: null }],
	});
	h.inference.script("curate-memory", note("週末に鎌倉へ自転車で出かける。"));
	await h.exchange("週末は鎌倉へ自転車で", "いいですね");
	await h.drain();
	// The model writes the same note again (with other punctuation) while reading a later exchange.
	h.inference.script("curate-memory", note("週末に、鎌倉へ自転車で出かける"));
	await h.exchange("仕事はエンジニアです", "承知しました");
	await h.drain();
	const notes = h.store.read(
		(db) => h.continuity.snapshotInTransaction(db, "c1").items,
	);
	expect(notes.map((n) => n.text)).toEqual(["週末に鎌倉へ自転車で出かける。"]);
});

// ---- finding 9: what counts as a failure, and the retry of a request that could not be taken ----

function settleDirect(
	h: StewardHarness,
	unitId: string,
	outcome:
		| { type: "expired" }
		| { type: "failed"; errorCode: string }
		| { type: "interrupted"; errorCode: string },
) {
	const job = jobOfUnit(h, unitId);
	return h.store.write((db) =>
		h.steward.handler.settleInTransaction(
			db,
			{
				jobId: job.id,
				generation: 1,
				attempt: job.attempt,
				payload: { unitId },
			},
			null,
			outcome,
		),
	);
}
/** The failed tries counted against events (one entry per event). */
const failureCounts = (h: StewardHarness) =>
	h.store
		.read(
			(db) =>
				db
					.query("SELECT failures FROM steward_event_failure ORDER BY seq")
					.all() as Array<{ failures: number }>,
		)
		.map((row) => row.failures);
const openCurate = (h: StewardHarness) =>
	h.units().filter((u) => u.step === "curate-memory" && u.state === "open");

test("an expired or interrupted job is not counted against its targets, and a new unit follows at once", async () => {
	const h = await setup();
	await h.exchange("こんにちは", "どうも");
	for (const outcome of [
		{ type: "expired" } as const,
		{ type: "interrupted", errorCode: "interrupted_by_restart" } as const,
	]) {
		const [unit] = openCurate(h);
		await settleDirect(h, unit!.id, outcome);
		expect(h.units().find((u) => u.id === unit!.id)!.state).toBe("failed");
		expect(failureCounts(h)).toEqual([]);
		expect(openCurate(h)).toHaveLength(1);
	}
});

test("a real failure is counted, and the target waits before the next try", async () => {
	const h = await setup();
	await h.exchange("こんにちは", "どうも");
	const [unit] = openCurate(h);
	await settleDirect(h, unit!.id, {
		type: "failed",
		errorCode: "provider_rejected",
	});
	expect(failureCounts(h)).toEqual([1, 1]);
	// No unit and no job for later: the timer brings the retry.
	expect(openCurate(h)).toEqual([]);
	expect(h.futureJobs()).toEqual([]);
	expect(h.timerTimes()).toEqual([h.time.ms + 15_000]);
	await h.fireTimer();
	expect(openCurate(h)).toHaveLength(1);
});

test("when the inference request cannot be taken, the step is tried again later: 30 s, then 60 s", async () => {
	const h = await setup();
	h.inference.state.unavailable = true;
	await h.exchange("a", "b");
	await h.pump(3);
	expect(h.timerTimes()).toEqual([h.time.ms + 30_000]);
	await h.fireTimer();
	await h.pump(3);
	expect(h.timerTimes()).toEqual([h.time.ms + 60_000]);
	expect(failureCounts(h)).toEqual([]);
	// The service is back: the next timer kicks the step through.
	h.inference.state.unavailable = false;
	h.inference.script("curate-memory", empty);
	await h.drain();
	expect(h.log().every((e) => e.curated)).toBe(true);
});
