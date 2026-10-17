import { expect, test } from "bun:test";
import {
	MEMORY_HISTORY_MAX_TOKENS,
	REFERENCE_WINDOW_TOKENS,
	TOKEN_ESTIMATE,
	contextBudgets,
	estimateJsonTokens,
	estimateMessageTokens,
	estimateTextTokens,
	outputReserveTokens,
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

test("a 256k window is split into 128k and 128k; a smaller one puts half in each", () => {
	expect(contextBudgets(REFERENCE_WINDOW_TOKENS)).toEqual({
		memoryHistory: MEMORY_HISTORY_MAX_TOKENS,
		task: MEMORY_HISTORY_MAX_TOKENS,
	});
	expect(contextBudgets(32_768)).toEqual({
		memoryHistory: 16_384,
		task: 16_384,
	});
	expect(contextBudgets(8193)).toEqual({ memoryHistory: 4096, task: 4097 });
	// A bigger window does not grow the memory and history half; the task takes the rest.
	expect(contextBudgets(1_000_000)).toEqual({
		memoryHistory: MEMORY_HISTORY_MAX_TOKENS,
		task: 1_000_000 - MEMORY_HISTORY_MAX_TOKENS,
	});
});

test("the answer's reservation is part of the task half: min(4096, window / 4)", () => {
	expect(outputReserveTokens(8192)).toBe(2048);
	expect(outputReserveTokens(262_144)).toBe(4096);
});
