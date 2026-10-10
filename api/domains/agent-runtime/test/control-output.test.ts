import { expect, test } from "bun:test";
import { parseControlOutput } from "../service/control-output";

test("control diagnostics distinguish non-text, empty, fenced, oversized and malformed output without retaining the response", () => {
	for (const [value, reason] of [
		[new Uint8Array([1]), "control_non_text"],
		["  ", "control_empty_output"],
		["```json\nSECRET_PROVIDER_TEXT\n```", "control_markdown_fence"],
		["SECRET_PROVIDER_TEXT".repeat(3000), "control_output_too_large"],
		['{"action":', "control_json_syntax"],
		['{"action":"finish"', "control_json_syntax"],
		["SECRET_PROVIDER_TEXT", "control_json_syntax"],
	] as const) {
		const result = parseControlOutput(value);
		expect(result.invalid).toBe(true);
		expect(result.diagnostic.reason).toBe(reason);
		expect(JSON.stringify(result.diagnostic)).not.toContain(
			"SECRET_PROVIDER_TEXT",
		);
	}
	expect(parseControlOutput('{"action":').diagnostic.validationCode).toBe(
		"unexpected_end",
	);
	expect(
		parseControlOutput('{"action":"finish"').diagnostic.validationCode,
	).toBe("expected_object_end");
	expect(parseControlOutput('"SECRET_PROVIDER_TEXT"').invalid).toBe(false);
	expect(
		parseControlOutput('{"action":{"toString":null}}').diagnostic.controlAction,
	).toBe("unrecognized");
	expect(
		parseControlOutput('{"action":"SECRET_PROVIDER_TEXT"}').diagnostic
			.controlAction,
	).toBe("unrecognized");
});

test("one whole JSON fence decodes without accepting surrounding prose, multiple blocks or malformed JSON", () => {
	const action = { action: "finish", report: { claims: [] } };
	const block = "```json\n" + JSON.stringify(action) + "\n```";
	expect(parseControlOutput(block)).toMatchObject({ invalid: false, action });
	for (const text of [
		"説明\n" + block,
		block + "\n説明",
		block + "\n" + block,
		'```json\n{"action":\n```',
	])
		expect(parseControlOutput(text).invalid).toBe(true);
});
