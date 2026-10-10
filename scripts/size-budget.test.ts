import { expect, test } from "bun:test";
import { type Budget, compare, FUNCTION_LIMIT, measure } from "./size-budget";

const body = (n: number) => "\tconsole.log(1);\n".repeat(n);

test("measures named, variable-held and nested functions by name, not line", () => {
	const text = [
		`export function big() {\n${body(10)}}`,
		`export const arrow = () => {\n${body(5)}};`,
		`export const holder = { run: function () {\n${body(3)}} };`,
		`export function outer() {\n\tconst inner = () => {\n${body(2)}\t};\n\treturn inner;\n}`,
		"",
	].join("\n");
	const { lines, functions } = measure("a.ts", text);
	expect(lines).toBe(text.split("\n").length - 1);
	expect(functions.big).toBe(12);
	expect(functions.arrow).toBe(7);
	expect(functions.run).toBe(5);
	expect(functions.outer).toBe(7);
	expect(functions["outer.inner"]).toBe(4);
	// moving a function down the file does not change its id
	expect(Object.keys(measure("a.ts", `\n\n${text}`).functions)).toEqual(
		Object.keys(functions),
	);
});

test("duplicate and anonymous names stay distinct", () => {
	const text = `[1].map(() => {\n});\n[2].map(() => {\n});\n`;
	expect(Object.keys(measure("a.ts", text).functions)).toEqual([
		"<anonymous>",
		"<anonymous>~2",
	]);
});

test("ratchet fails on growth and new offenders, not on shrinkage", () => {
	const recorded: Budget = {
		files: { "a.ts": 900 },
		functions: { "a.ts#f": 400 },
	};
	expect(compare(recorded, recorded)).toEqual([]);
	expect(
		compare({ files: { "a.ts": 850 }, functions: { "a.ts#f": 300 } }, recorded),
	).toEqual([]);
	expect(
		compare({ files: { "a.ts": 901 }, functions: { "a.ts#f": 401 } }, recorded),
	).toEqual([
		"size-budget: a.ts grew 900 -> 901 (limit 800)",
		"size-budget: a.ts#f grew 400 -> 401 (limit 300)",
	]);
	const fresh = compare(
		{ files: { "b.ts": 801 }, functions: { "b.ts#g": FUNCTION_LIMIT + 1 } },
		recorded,
	);
	expect(fresh).toHaveLength(2);
	expect(fresh[0]).toContain("new file over 800 lines: b.ts");
	expect(fresh[1]).toContain("new function over 300 lines: b.ts#g");
});
