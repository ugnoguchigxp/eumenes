import { expect, test } from "bun:test";
import {
	cacheInput,
	cacheMarker,
	cacheUpdatedMarker,
	cacheReferenceMatches,
} from "./cache-input";
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

test("reference validation rejects stale values and invalid JSON shapes", () => {
	for (const json of [false, true]) {
		const answer = (value: string) =>
			json ? JSON.stringify({ value }) : value;
		expect(
			cacheReferenceMatches(
				answer(cacheUpdatedMarker),
				cacheUpdatedMarker,
				json,
			),
		).toBe(true);
		expect(
			cacheReferenceMatches(answer(cacheMarker), cacheUpdatedMarker, json),
		).toBe(false);
		expect(
			cacheReferenceMatches(answer(cacheUpdatedMarker), cacheMarker, json),
		).toBe(false);
	}
	for (const answer of [
		"null",
		"[]",
		"broken",
		JSON.stringify({ value: cacheUpdatedMarker, extra: true }),
	])
		expect(cacheReferenceMatches(answer, cacheUpdatedMarker, true)).toBe(false);
});

test("a background update must change the reference answer, so stale input cannot pass", () => {
	const updated = "SYNTHETIC_REVISED_3916";
	const messages = renderContext(
		cacheInput(14000, updated),
		"current",
	).messages;
	expect(messages.some((m) => m.content.includes(`VALUE=${updated}`))).toBe(
		true,
	);
	expect(
		messages.some((m) => m.content.includes("VALUE=SYNTHETIC_CACHE_7241")),
	).toBe(false);
});
