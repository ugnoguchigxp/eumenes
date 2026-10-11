import { afterEach, expect, test } from "bun:test";
import { decodeLlmJson, parseLlmJson } from "./llm-json";
import { configureLogging, withLogContext } from "./logger";

afterEach(() => configureLogging({ level: "silent" }));

test("valid model JSON keeps values, nesting and numeric types", () => {
	const value = {
		日本語: '引用 " と改行\n',
		items: [1, false, null, { x: "y" }],
	};
	expect(decodeLlmJson(JSON.stringify(value))).toEqual({
		value,
		repaired: false,
	});
	expect(Object.is(parseLlmJson("-0"), -0)).toBe(true);
});
for (const input of [
	'{kind:"web", question:"東京の天気",}',
	"{'kind':'web','question':'東京の天気'}",
	'{"kind":"web" "question":"東京の天気"}',
	'```json\n{kind:"web",question:"東京の天気",}\n```',
	'<think>untrusted reasoning</think>\n{kind:"web",question:"東京の天気"}',
])
	test(`syntax correction preserves the research request: ${input}`, () => {
		expect(decodeLlmJson(input)).toEqual({
			value: { kind: "web", question: "東京の天気" },
			repaired: true,
		});
	});
test("nested correction preserves all keys and values, including escaped text", () => {
	expect(
		parseLlmJson(
			"{items:[{'text':'it\\'s \\\"quoted\\\"','value':2,},true,],}",
		),
	).toEqual({
		items: [{ text: 'it\'s "quoted"', value: 2 }, true],
	});
	expect(parseLlmJson('{"a":"\\u65e5", "items":[1 2 3,],}')).toEqual({
		a: "日",
		items: [1, 2, 3],
	});
});
for (const input of [
	'{"action":"invoke","arguments":{"durationSeconds":20}',
	'{"question":"unfinished',
	'{"durationSeconds":}',
	'{"favorite":undefined}',
	'{"favorite":True}',
	'{"q":weather}',
	'{"items":[1,...]}',
	'{"items":[1,,2]}',
	'{"items":[,1]}',
	'{"a":1/*comment*/}',
	'Here is JSON: {"a":1}',
	'{"a":1}{"b":2}',
	'{"a":1,"a":2}',
	'{"a":1,"\\u0061":2}',
	"{a:1,'a':2,}",
	'<think>a</think><think>b</think>{"a":1}',
])
	test(`ambiguous, incomplete or value-changing output is rejected: ${input}`, () => {
		expect(() => parseLlmJson(input)).toThrow();
	});
test("output budgets and depth are enforced before adoption", () => {
	expect(() => parseLlmJson('{"日本語":1}', 8)).toThrow("llm_json_too_large");
	expect(() => parseLlmJson("[".repeat(65) + "0" + "]".repeat(65))).toThrow(
		"llm_json_too_deep",
	);
	expect(() => parseLlmJson(new Uint8Array())).toThrow("llm_json_non_text");
});
test("correction does not invent, remove or coerce contract fields", () => {
	expect(parseLlmJson('{durationSeconds:"20", extra:"keep",}')).toEqual({
		durationSeconds: "20",
		extra: "keep",
	});
	expect(() => parseLlmJson("{PRIVATE_SECRET:")).toThrow("llm_json_incomplete");
});
test("syntax correction logs only fixed classification and capacity", () => {
	const lines: string[] = [];
	configureLogging({
		level: "debug",
		destination: { write: (line) => void lines.push(line) },
	});
	parseLlmJson("{question:'PRIVATE_PROVIDER_RESPONSE',}");
	expect(lines).toHaveLength(1);
	expect(JSON.parse(lines[0]!)).toMatchObject({
		event: "llm_json.corrected",
		reason: "syntax",
		bytes: expect.any(Number),
	});
	expect(lines[0]).not.toContain("PRIVATE_PROVIDER_RESPONSE");
});

test("rejected correction retains its safe reason and IDs without claiming a committed failure", () => {
	const lines: string[] = [];
	configureLogging({
		level: "debug",
		destination: { write: (line) => void lines.push(line) },
	});
	for (const [text, code] of [
		[
			"{question:'PRIVATE_PROVIDER_RESPONSE',question:'other',}",
			"llm_json_duplicate_key",
		],
		["{question:'PRIVATE_PROVIDER_RESPONSE',value:}", "llm_json_unsafe_repair"],
	] as const) {
		expect(() =>
			withLogContext({ runId: "run-test", jobId: "job-test" }, () =>
				parseLlmJson(text),
			),
		).toThrow(code);
		expect(JSON.parse(lines.at(-1)!)).toMatchObject({
			level: "debug",
			component: "llm-json",
			event: "llm_json.rejected",
			reason: code,
			runId: "run-test",
			jobId: "job-test",
			bytes: Buffer.byteLength(text),
		});
	}
	expect(lines).toHaveLength(2);
	expect(lines.join("\n")).not.toContain("PRIVATE_PROVIDER_RESPONSE");
	configureLogging({
		level: "warn",
		destination: { write: (line) => void lines.push(line) },
	});
	expect(() => parseLlmJson("{action:'invoke',action:'finish',}")).toThrow(
		"llm_json_duplicate_key",
	);
	expect(lines).toHaveLength(2);
});
