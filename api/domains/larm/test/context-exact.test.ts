import { afterEach, expect, test } from "bun:test";
import { estimateMessageTokens } from "../../../infrastructure/context-budget";
import { configureLogging } from "../../../infrastructure/logger";
import { fitContext } from "../service/context";

const window = {
	maxTokens: 1000,
	outputReserveTokens: 100,
	safetyMarginTokens: 100,
};
const budget = 800;
afterEach(() => configureLogging({ level: "silent" }));

test("the fit is judged by the token estimate: Japanese counts one token per character, not three bytes", () => {
	const messages = [
		{ role: "system" as const, content: "policy" },
		{ role: "user" as const, content: "あ".repeat(500) },
		{ role: "user" as const, content: "request" },
	];
	// 500 characters are about 500 tokens (1500 UTF-8 bytes would have been over the budget).
	expect(fitContext(messages, window).messages).toEqual(messages);
	const long = [
		messages[0]!,
		{ role: "user" as const, content: "あ".repeat(1000) },
		messages[2]!,
	];
	expect(fitContext(long, window).messages).toHaveLength(2);
});

test("a request the server may trim fails only when nothing more can be dropped", () => {
	const messages = [
		{ role: "system" as const, content: "x".repeat(4000) },
		{ role: "user" as const, content: "y".repeat(4000) },
		{ role: "user" as const, content: "request" },
	];
	expect(() => fitContext(messages, window)).toThrow("context_window_exceeded");
});

test("the leading system run and the last message survive trimming; the oldest conversation is dropped first", () => {
	const messages = [
		{ role: "system" as const, content: "policy" },
		{ role: "system" as const, content: "memory" },
		{ role: "system" as const, content: "world" },
		...Array.from({ length: 6 }, (_, i) => ({
			role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
			content: `turn${i}-${"x".repeat(1000)}`,
		})),
	];
	expect(estimateMessageTokens(messages)).toBeGreaterThan(budget);
	const fitted = fitContext(messages, window).messages;
	expect(fitted.slice(0, 3)).toEqual(messages.slice(0, 3));
	expect(fitted.at(-1)).toEqual(messages.at(-1));
	expect(fitted.length).toBeLessThan(messages.length);
	// What remains of the conversation is the newest suffix.
	expect(fitted.slice(3)).toEqual(
		messages.slice(messages.length - (fitted.length - 3)),
	);
});

const exactList = () => {
	// S, then 6 adopted history messages, a working-memory system message in the middle of them, then
	// this turn's input.
	const history = Array.from({ length: 6 }, (_, i) => ({
		role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
		content: `turn${i}-${"x".repeat(400)}`,
	}));
	return [
		{ role: "system" as const, content: "policy" },
		...history.slice(0, 4),
		{ role: "system" as const, content: "working-memory" },
		...history.slice(4),
		{ role: "user" as const, content: "request" },
	];
};

test("an exact request over the window drops the oldest history, never the rest, and does not fail", () => {
	const lines: string[] = [];
	configureLogging({
		level: "warn",
		destination: { write: (l) => void lines.push(l) },
	});
	const messages = exactList();
	const fitted = fitContext(messages, window, true, {
		instructionCount: 1,
		historyCount: 6,
	});
	// Fits as it is: nothing is dropped.
	expect(fitted.messages).toEqual(messages);
	expect(lines).toHaveLength(0);
	// A smaller window: the oldest exchanges go, two messages at a time.
	const small = { ...window, maxTokens: 520 };
	const trimmed = fitContext(messages, small, true, {
		instructionCount: 1,
		historyCount: 6,
	});
	expect(trimmed.messages.length).toBeLessThan(messages.length);
	expect(trimmed.messages[0]).toEqual(messages[0]!);
	expect(trimmed.messages.map((m) => m.content)).toContain("working-memory");
	expect(trimmed.messages.at(-1)).toEqual(messages.at(-1)!);
	// The newest history stays; the oldest is gone.
	expect(trimmed.messages.map((m) => m.content)).not.toContain(
		messages[1]!.content,
	);
	expect(trimmed.messages.map((m) => m.content)).toContain(
		messages[7]!.content,
	);
	expect(trimmed.history!.historyCount).toBe(
		6 - (messages.length - trimmed.messages.length),
	);
	const logged = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
	expect(logged.event).toBe("larm.exact_context_over_window");
	expect(logged.droppedMessages).toBe(
		messages.length - trimmed.messages.length,
	);
	expect(JSON.stringify(logged)).not.toContain("turn0");
});

test("an exact request that cannot be fitted is sent as it is for the provider to judge, never failed here", () => {
	const messages = exactList();
	const range = { instructionCount: 1, historyCount: 6 };
	// Even with no history the system part and the request alone are over this window.
	const tiny = { ...window, maxTokens: 230 };
	const fitted = fitContext(messages, tiny, true, range);
	expect(fitted.history!.historyCount).toBe(0);
	expect(fitted.messages.map((m) => m.content)).toEqual([
		"policy",
		"working-memory",
		"request",
	]);
	// Without the position of the history nothing can be dropped, and still nothing fails.
	expect(fitContext(messages, tiny, true).messages).toEqual(messages);
});

test("history goes by whole exchanges: an unanswered run does not leave an assistant message first", () => {
	const text = (tag: string) => `${tag}-${"x".repeat(400)}`;
	// The first run had no answer: two user messages in a row, then exchanges.
	const history = [
		{ role: "user" as const, content: text("unanswered") },
		...Array.from({ length: 3 }, (_, i) => [
			{ role: "user" as const, content: text(`q${i}`) },
			{ role: "assistant" as const, content: text(`a${i}`) },
		]).flat(),
	];
	const messages = [
		{ role: "system" as const, content: "policy" },
		...history,
		{ role: "user" as const, content: "request" },
	];
	for (let maxTokens = 330; maxTokens < 1000; maxTokens += 40) {
		const small = { ...window, maxTokens };
		const exact = fitContext(messages, small, true, {
			instructionCount: 1,
			historyCount: history.length,
		});
		const first = exact.messages[1]!;
		if (exact.history!.historyCount > 0) expect(first.role).toBe("user");
		expect(exact.messages.length - 2 === exact.history!.historyCount).toBe(
			true,
		);
		try {
			const trimmed = fitContext(messages, small).messages;
			if (trimmed.length > 2) expect(trimmed[1]!.role).toBe("user");
		} catch (error) {
			expect((error as Error).message).toBe("context_window_exceeded");
		}
	}
});
