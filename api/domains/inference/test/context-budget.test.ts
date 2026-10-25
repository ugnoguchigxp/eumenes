import { expect, test } from "bun:test";
import {
	MIN_SECTION_ROOM_TOKENS,
	OUTPUT_RESERVE_DEFAULT_TOKENS,
	SECTION_LIMITS,
	TOKEN_ESTIMATE,
	estimateJsonTokens,
	estimateMessageTokens,
	estimateTextTokens,
	logTargets,
	planWindow,
} from "..";

test("Japanese text is about one token per character, ASCII about one per four bytes", () => {
	expect(estimateTextTokens("あ".repeat(1000))).toBe(1000);
	expect(estimateTextTokens("漢字かなカナ")).toBe(6);
	expect(estimateTextTokens("a".repeat(4000))).toBe(1000);
	// Mixed: each kind by its own rule (the full-width comma and brackets are CJK symbols).
	expect(estimateTextTokens("あ".repeat(10) + "a".repeat(40))).toBe(20);
	expect(estimateTextTokens("、」")).toBe(2);
	expect(estimateTextTokens("")).toBe(0);
	// The old byte count would have said 3000 for the Japanese text: the estimate is a third of that.
	expect(Buffer.byteLength("あ".repeat(1000))).toBe(3000);
});

test("JSON adds its structure to the text, and a message adds its framing", () => {
	const text = "a".repeat(400);
	const plain = estimateTextTokens(text);
	const json = estimateJsonTokens({ role: "user", content: text });
	expect(json).toBeGreaterThan(plain);
	// The structure is a small addition, not a multiple of the text.
	expect(json - plain).toBeLessThan(40);
	// Escapes of the JSON text are part of it.
	expect(estimateJsonTokens({ text: 'a"b\n' })).toBeGreaterThan(
		estimateJsonTokens({ text: "ab" }),
	);
	const one = estimateMessageTokens([{ content: text }]);
	expect(one).toBe(
		plain +
			TOKEN_ESTIMATE.messageOverheadTokens +
			TOKEN_ESTIMATE.requestOverheadTokens,
	);
	expect(estimateMessageTokens([{ content: text }, { content: text }])).toBe(
		one + plain + TOKEN_ESTIMATE.messageOverheadTokens,
	);
	expect(estimateMessageTokens([{ content: "", images: [{}, {}] }])).toBe(
		TOKEN_ESTIMATE.requestOverheadTokens +
			TOKEN_ESTIMATE.messageOverheadTokens +
			2 * TOKEN_ESTIMATE.imageTokens,
	);
});

test("a 256k window plans 80%: the sections reach their absolute limits and the work area is the rest", () => {
	const plan = planWindow({ window: 262_144, fixed: 3_000, output: 8_192 });
	expect(plan.planned).toBe(209_715);
	expect(plan.workMin).toBe(52_428);
	expect(plan.room).toBe(146_095);
	expect(plan.sections).toEqual({
		profile: 12_000,
		episode: 2_000,
		log: 20_000,
		state: 2_000,
		now: 3_000,
	});
	expect(plan.usable).toBe(true);
});

test("the output reserve is the connection's when it gives one, else the default", () => {
	expect(planWindow({ window: 100_000, fixed: 0 }).output).toBe(
		OUTPUT_RESERVE_DEFAULT_TOKENS,
	);
	expect(planWindow({ window: 100_000, fixed: 0, output: 2_000 }).output).toBe(
		2_000,
	);
});

test("section limits are min(share × R, max): their sum never exceeds R, so the work area stays", () => {
	for (const window of [32_768, 65_536, 131_072, 262_144, 1_000_000]) {
		const plan = planWindow({ window, fixed: 3_000 });
		const sum = Object.values(plan.sections).reduce((a, b) => a + b, 0);
		expect(sum).toBeLessThanOrEqual(plan.room);
		expect(
			plan.planned - plan.output - plan.fixed - sum,
		).toBeGreaterThanOrEqual(plan.workMin);
		for (const [name, limit] of Object.entries(SECTION_LIMITS))
			expect(
				plan.sections[name as keyof typeof SECTION_LIMITS],
			).toBeLessThanOrEqual(limit.max);
	}
});

test("a window whose room is below the least is not usable for conversation", () => {
	expect(planWindow({ window: 16_384, fixed: 3_000 }).usable).toBe(false);
	const smallest = planWindow({ window: 32_768, fixed: 3_000, output: 4_000 });
	expect(smallest.room).toBeGreaterThanOrEqual(MIN_SECTION_ROOM_TOKENS);
	expect(smallest.usable).toBe(true);
});

test("log targets keep ≤ low < high ≤ cap at every size", () => {
	expect(logTargets(16_000)).toEqual({
		cap: 16_000,
		high: 10_000,
		low: 5_000,
		keep: 4_000,
	});
	// The least room (R = 8,000) gives a 3,200 log.
	expect(logTargets(3_200)).toEqual({
		cap: 3_200,
		high: 3_200,
		low: 1_600,
		keep: 1_600,
	});
	for (let cap = 2; cap <= 20_000; cap += 997) {
		const t = logTargets(cap);
		expect(t.keep).toBeLessThanOrEqual(t.low);
		expect(t.low).toBeLessThan(t.high);
		expect(t.high).toBeLessThanOrEqual(t.cap);
	}
});
