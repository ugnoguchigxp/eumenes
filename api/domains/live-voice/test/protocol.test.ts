import { expect, test } from "bun:test";
import { historyInput, validPcm } from "../service/protocol";
test("seed history stays within a conservative byte/token budget without splitting unicode", () => {
	const input = historyInput(
		Array.from({ length: 150 }, () => ({
			role: "user" as const,
			text: "𠮷野家で話す。".repeat(400),
		})),
	);
	expect(input.length).toBeLessThanOrEqual(40);
	expect(
		input.reduce(
			(n, m) => n + new TextEncoder().encode(m.content[0]!.text).length,
			0,
		),
	).toBeLessThanOrEqual(6000);
	expect(input.every((m) => !m.content[0]!.text.includes("\uFFFD"))).toBe(true);
});
test("PCM accepts only bounded canonical base64 with complete 16-bit samples", () => {
	expect(validPcm("AAAAAA==", 4)).toBe(true);
	expect(validPcm("AA==", 4)).toBe(false);
	expect(validPcm("AAAAAA==x", 4)).toBe(false);
	expect(validPcm("AAAAAA==", 2)).toBe(false);
});
