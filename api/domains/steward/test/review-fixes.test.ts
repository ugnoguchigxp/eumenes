import { afterEach, expect, test } from "bun:test";
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
const empty = { resolve: [] };
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
// ---- a forget takes what stands on it ----

/** The exchange where the address was said, and `count` memories the earlier reflection kept of it. */
async function learn(h: StewardHarness, count = 1) {
	const first = await h.run({
		user: "私の住所は東京都千代田区です",
		answer: "承知しました",
		end: "completed",
	});
	await h.store.write((db) =>
		h.memory.applyCurationInTransaction(db, {
			conversationId: "c1",
			items: Array.from({ length: count }, (_, i) => ({
				op: "remember" as const,
				kind: "preference" as const,
				key: `k.${i + 1}`,
				text: `住所に関する記憶${i + 1}`,
				messageId: first.inputMessageId,
				quote: null,
			})),
		}),
	);
	return first;
}

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

test("a forget the memory refuses as too large ends the request without forgetting", async () => {
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
		return { ...empty, resolve: [resolve({ refs: [ref] })] };
	});
	await h.run({
		user: "忘れて",
		end: "completed",
		requests: [{ kind: "forget", what: "住所の記憶" }],
	});
	await h.drain();
	expect(h.memory.list()).toHaveLength(2);
	expect(h.inbox()).toMatchObject([
		{ state: "none", resultCode: "forget_limit" },
	]);
	expect(noticeTexts(h).some((t) => t.includes("一度に忘れられる件数"))).toBe(
		true,
	);
});

// ---- finding 4: the conversation route and the strict schema; the user is told ----

test("every step asks for the conversation's own route and a strict output schema", async () => {
	const h = await setup();
	h.inference.script("curate-memory", empty, empty, empty);
	await h.run({
		user: "こんにちは",
		end: "completed",
		requests: [{ kind: "remember", what: "z" }],
	});
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

// ---- finding 9: what counts as a failure, and the retry of a request that could not be taken ----

/** A run that ended and left one request: the only thing that makes a unit. */
const ask = (h: StewardHarness) =>
	h.run({
		user: "こんにちは",
		answer: "どうも",
		end: "completed",
		requests: [{ kind: "remember", what: "あいさつ" }],
	});

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
/** The failed tries counted against the requests. */
const failureCounts = (h: StewardHarness) => h.inbox().map((r) => r.failures);
const openCurate = (h: StewardHarness) =>
	h.units().filter((u) => u.step === "curate-memory" && u.state === "open");

test("an expired or interrupted job is not counted against its targets, and a new unit follows at once", async () => {
	const h = await setup();
	await ask(h);
	for (const outcome of [
		{ type: "expired" } as const,
		{ type: "interrupted", errorCode: "interrupted_by_restart" } as const,
	]) {
		const [unit] = openCurate(h);
		await settleDirect(h, unit!.id, outcome);
		expect(h.units().find((u) => u.id === unit!.id)!.state).toBe("failed");
		expect(failureCounts(h)).toEqual([0]);
		expect(openCurate(h)).toHaveLength(1);
	}
});

test("a real failure is counted, and the target waits before the next try", async () => {
	const h = await setup();
	await ask(h);
	const [unit] = openCurate(h);
	await settleDirect(h, unit!.id, {
		type: "failed",
		errorCode: "provider_rejected",
	});
	expect(failureCounts(h)).toEqual([1]);
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
	await ask(h);
	await h.pump(3);
	expect(h.timerTimes()).toEqual([h.time.ms + 30_000]);
	await h.fireTimer();
	await h.pump(3);
	expect(h.timerTimes()).toEqual([h.time.ms + 60_000]);
	expect(failureCounts(h)).toEqual([0]);
	// The service is back: the next timer kicks the step through.
	h.inference.state.unavailable = false;
	h.inference.script("curate-memory", empty, empty, empty);
	await h.drain();
	expect(h.inbox()).toMatchObject([{ state: "none" }]);
});
