import { test, expect } from "bun:test";
import { fitContext } from "../service/context";
test("required control and summary segments are never silently truncated", () => {
	const messages = [
		{ role: "system" as const, content: "policy" },
		{ role: "user" as const, content: "skill".repeat(500) },
		{ role: "user" as const, content: "request" },
	];
	const window = {
		maxTokens: 1000,
		outputReserveTokens: 100,
		safetyMarginTokens: 100,
	};
	expect(fitContext(messages, window)).toHaveLength(2);
	expect(() => fitContext(messages, window, true)).toThrow(
		"context_window_exceeded",
	);
	expect(fitContext(messages, { ...window, maxTokens: 5000 }, true)).toEqual(
		messages,
	);
});

test("the leading system run and the last message survive trimming; the oldest conversation is dropped first", () => {
	const messages = [
		{ role: "system" as const, content: "policy" },
		{ role: "system" as const, content: "memory" },
		{ role: "system" as const, content: "world" },
		...Array.from({ length: 6 }, (_, i) => ({
			role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
			content: `turn${i}-${"x".repeat(200)}`,
		})),
	];
	const window = {
		maxTokens: 1000,
		outputReserveTokens: 100,
		safetyMarginTokens: 100,
	};
	const total = new TextEncoder().encode(JSON.stringify(messages)).length;
	expect(total).toBeGreaterThan(800);
	const fitted = fitContext(messages, window);
	expect(fitted.slice(0, 3)).toEqual(messages.slice(0, 3));
	expect(fitted.at(-1)).toEqual(messages.at(-1));
	expect(fitted.length).toBeLessThan(messages.length);
	// What remains of the conversation is the newest suffix.
	expect(fitted.slice(3)).toEqual(
		messages.slice(messages.length - (fitted.length - 3)),
	);
	// Nothing but system blocks plus the last message can still be too large.
	expect(() => fitContext(messages, { ...window, maxTokens: 400 })).toThrow(
		"context_window_exceeded",
	);
});
