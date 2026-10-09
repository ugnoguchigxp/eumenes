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
