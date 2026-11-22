import { expect, test } from "bun:test";
import {
	type Budget,
	compare,
	FUNCTION_LIMIT,
	measure,
	notices,
	ratchetBudget,
} from "./size-budget";

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
		testFiles: { "a.test.ts": 1200 },
	};
	expect(compare(recorded, recorded)).toEqual([]);
	expect(
		compare(
			{
				files: { "a.ts": 850 },
				functions: { "a.ts#f": 300 },
				testFiles: { "a.test.ts": 1000 },
			},
			recorded,
		),
	).toEqual([]);
	expect(
		compare(
			{
				files: { "a.ts": 901 },
				functions: { "a.ts#f": 401 },
				testFiles: { "a.test.ts": 1201 },
			},
			recorded,
		),
	).toEqual([
		"size-budget: a.ts grew 900 -> 901 (limit 800)",
		"size-budget: a.ts#f grew 400 -> 401 (limit 300)",
		"size-budget: a.test.ts grew 1200 -> 1201 (limit 1000)",
	]);
	const fresh = compare(
		{
			files: { "b.ts": 801 },
			functions: { "b.ts#g": FUNCTION_LIMIT + 1 },
			testFiles: { "b.test.ts": 1001 },
		},
		recorded,
	);
	expect(fresh).toHaveLength(3);
	expect(fresh[0]).toContain("new file over 800 lines: b.ts");
	expect(fresh[1]).toContain("new function over 300 lines: b.ts#g");
	expect(fresh[2]).toContain("new test file over 1000 lines: b.test.ts");
});

test("ratchetBudget records only shrinkage and removals, never new offenders or growth", () => {
	const recorded: Budget = {
		files: { "a.ts": 900, "gone.ts": 850 },
		functions: { "a.ts#shrink": 420, "a.ts#grow": 350, "a.ts#fixed": 310 },
		testFiles: { "a.test.ts": 1200 },
	};
	const current: Budget = {
		files: { "a.ts": 860, "new-big.ts": 910 },
		functions: {
			"a.ts#shrink": 360,
			"a.ts#grow": 410,
			"new-big.ts#huge": 380,
		},
		testFiles: { "a.test.ts": 1250, "new.test.ts": 1050 },
	};
	const result = ratchetBudget(current, recorded);
	expect(result.next).toEqual({
		files: { "a.ts": 860 },
		functions: { "a.ts#shrink": 360, "a.ts#grow": 350 },
		testFiles: { "a.test.ts": 1200 },
	});
	expect(result.reduced).toEqual([
		"a.ts: 900 -> 860",
		"a.ts#shrink: 420 -> 360",
	]);
	expect(result.removed).toEqual(["gone.ts (was 850)", "a.ts#fixed (was 310)"]);
	expect(result.blocked).toHaveLength(5);
	expect(result.blocked.some((line) => line.includes("new-big.ts"))).toBe(true);
	expect(result.blocked.some((line) => line.includes("a.ts#grow grew"))).toBe(
		true,
	);
	expect(result.blocked.some((line) => line.includes("new.test.ts"))).toBe(
		true,
	);
});

test("notices report meaningful shrinkage and resolved entries without triggering size-budget error prefix", () => {
	const recorded: Budget = {
		files: { "gone.ts": 850 },
		functions: { "a.ts#big": 400, "a.ts#tiny-drop": 350 },
		testFiles: {},
	};
	const current: Budget = {
		files: {},
		functions: { "a.ts#big": 350, "a.ts#tiny-drop": 345 },
		testFiles: {},
	};
	const found = notices(current, recorded);
	expect(found).toHaveLength(2);
	expect(found.every((line) => line.startsWith("size-budget-notice: "))).toBe(
		true,
	);
	expect(found.some((line) => line.includes("gone.ts"))).toBe(true);
	expect(
		found.some((line) => line.includes("a.ts#big shrank 400 -> 350")),
	).toBe(true);
});
