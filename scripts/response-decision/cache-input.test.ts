import { expect, test } from "bun:test";
import { cacheInput } from "./cache-input";
import {
	renderContext,
	contextPartSizes,
} from "../../api/domains/dialogue/service/context-render";
import { estimateMessageTokens } from "../../api/domains/inference";

test("cache trajectory uses the real layout and synthetic reference data around fourteen thousand estimated tokens", () => {
	const input = cacheInput();
	const messages = renderContext(input, "current").messages;
	expect(estimateMessageTokens(messages)).toBeGreaterThanOrEqual(14000);
	expect(estimateMessageTokens(messages)).toBeLessThan(14500);
	expect(messages.at(-1)).toBe(input.input);
	expect(input.history.turns).toHaveLength(2);
	expect(input.working[0]!.authority).toBe("reference");
	expect(contextPartSizes(input).W).toBeGreaterThan(0);
});
