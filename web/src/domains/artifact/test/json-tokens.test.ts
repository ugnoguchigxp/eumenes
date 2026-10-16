import { tokenizeJsonLines } from "@eumenes/artifact-ui";
import { expect, test } from "vitest";

const kinds = (line: ReturnType<typeof tokenizeJsonLines>[number]) =>
	line.filter((t) => t.type !== "space").map((t) => [t.type, t.text]);

test("keys, strings, numbers, literals and punctuation are told apart", () => {
	const lines = tokenizeJsonLines(
		JSON.stringify({ a: "x", n: -1500, ok: true, none: null }, null, 2),
	);
	expect(kinds(lines[1]!)).toEqual([
		["key", '"a"'],
		["punct", ":"],
		["string", '"x"'],
		["punct", ","],
	]);
	expect(kinds(lines[2]!)).toEqual([
		["key", '"n"'],
		["punct", ":"],
		["number", "-1500"],
		["punct", ","],
	]);
	expect(kinds(lines[3]!)[2]).toEqual(["literal", "true"]);
	expect(kinds(lines[4]!)[2]).toEqual(["literal", "null"]);
});

test("escaped quotes and colons inside a string stay one string", () => {
	const text = JSON.stringify({ q: 'he said "hi": ok\\', 'k:"x': 1 }, null, 2);
	const lines = tokenizeJsonLines(text);
	expect(kinds(lines[1]!)[2]).toEqual(["string", '"he said \\"hi\\": ok\\\\"']);
	expect(kinds(lines[2]!)[0]).toEqual(["key", '"k:\\"x"']);
});

test("nested objects and arrays keep their structure line by line", () => {
	const text = JSON.stringify({ a: { b: [1, { c: "d" }] } }, null, 2);
	const lines = tokenizeJsonLines(text);
	expect(lines).toHaveLength(text.split("\n").length);
	expect(kinds(lines[1]!)).toEqual([
		["key", '"a"'],
		["punct", ":"],
		["punct", "{"],
	]);
	expect(lines[4]![0]).toEqual({ type: "space", text: "      " });
});

test("unicode text survives and the tokens join back to the exact input", () => {
	const text = JSON.stringify(
		{ 見出し: "来場者アンケート🙂", n: [0, 12] },
		null,
		2,
	);
	const lines = tokenizeJsonLines(text);
	expect(kinds(lines[1]!)[0]).toEqual(["key", '"見出し"']);
	expect(kinds(lines[1]!)[2]).toEqual(["string", '"来場者アンケート🙂"']);
	expect(lines.map((line) => line.map((t) => t.text).join("")).join("\n")).toBe(
		text,
	);
});

test("odd input never throws and is returned unchanged", () => {
	const text = '{ "open: \\"';
	const lines = tokenizeJsonLines(text);
	expect(lines.map((line) => line.map((t) => t.text).join("")).join("\n")).toBe(
		text,
	);
});
