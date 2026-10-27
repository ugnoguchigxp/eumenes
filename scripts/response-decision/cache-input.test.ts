import { expect, test } from "bun:test";
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
	expect(input.messages[0]!.role).toBe("system");
	// The recent conversation alternates from the agent's first utterance; the last message is State and the question.
	expect(input.messages[1]).toMatchObject({ role: "assistant" });
	expect(input.messages[1]!.content).toContain(`VALUE=${cacheMarker}`);
	expect(input.messages.at(-2)!.role).toBe("assistant");
	expect(input.messages.at(-1)!.content).toStartWith("## State\n");
	expect(input.messages.at(-1)!.content).toContain("\n\n## User\n");
	expect(input.sections.recent).toBeGreaterThan(input.sections.last);
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
	expect(updated.messages[1]!.content).toContain(`VALUE=${cacheUpdatedMarker}`);
	expect(JSON.stringify(updated.messages)).not.toContain(
		`VALUE=${cacheMarker}`,
	);
	expect(updated.messages.at(-1)!.content).toContain("- 追加の一行");
	// The system part is the same; the change starts at the recent conversation's first utterance.
	const original = cacheInput();
	expect(updated.messages[0]).toEqual(original.messages[0]!);
	expect(updated.messages[1]!.content.indexOf("VALUE=")).toBe(
		original.messages[1]!.content.indexOf("VALUE="),
	);
});
