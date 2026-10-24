import { expect, test } from "bun:test";
import { DOCUMENT_KEYS } from "../../api/domains/dialogue/service/context-document";
import { estimateMessageTokens } from "../../api/domains/inference";
import {
	cacheInput,
	cacheMarker,
	cacheReferenceMatches,
	cacheUpdatedMarker,
} from "./cache-input";

test("cache trajectory uses the product's message layout and synthetic reference data around fourteen thousand estimated tokens", () => {
	const input = cacheInput();
	const tokens = estimateMessageTokens(input.messages);
	expect(tokens).toBeGreaterThanOrEqual(14000);
	expect(tokens).toBeLessThan(14500);
	expect(input.messages.map((m) => m.role)).toEqual(["system", "user", "user"]);
	// The document is the product's own: its keys in their fixed order, and it is the message sent.
	expect(Object.keys(JSON.parse(input.messages[1]!.content))).toEqual([
		...DOCUMENT_KEYS,
	]);
	expect(input.messages[1]!.content).toBe(input.document.text);
	expect(input.document.sections.log.tokens).toBeGreaterThan(
		input.document.sections.state.tokens,
	);
	expect(input.messages[1]!.content).toContain(`VALUE=${cacheMarker}`);
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
	const updated = cacheInput(14000, cacheUpdatedMarker, "追加の一行");
	const text = updated.messages[1]!.content;
	expect(text).toContain(`VALUE=${cacheUpdatedMarker}`);
	expect(text).not.toContain(`VALUE=${cacheMarker}`);
	expect(text).toContain("追加の一行");
	// The system part and the end of the log are the same; the change starts at the log's first event.
	const original = cacheInput();
	expect(updated.messages[0]).toEqual(original.messages[0]!);
	expect(updated.messages[1]!.content.indexOf("VALUE=")).toBe(
		original.messages[1]!.content.indexOf("VALUE="),
	);
});
