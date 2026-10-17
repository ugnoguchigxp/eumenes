import { describe, expect, test } from "bun:test";
import type { CompositionValue } from "./composition-contracts";
import {
	createBudget,
	cyclicNames,
	evaluateExpression,
	evaluationStepLimit,
	parseExpression,
} from "./composition-expressions";

function run(
	source: string,
	values: Record<string, CompositionValue> = {},
): CompositionValue {
	const parsed = parseExpression(source);
	if (!parsed.ok) throw new Error(`parse failed: ${parsed.reason}`);
	const map = new Map(Object.entries(values));
	return evaluateExpression(parsed.ast, { get: (name) => map.get(name) });
}
const reason = (source: string) => {
	const parsed = parseExpression(source);
	return parsed.ok ? "ok" : parsed.reason;
};

describe("literals and operators", () => {
	test("numbers, strings, booleans and constants", () => {
		expect(run("42")).toBe(42);
		expect(run("1.5e2")).toBe(150);
		expect(run(".5")).toBe(0.5);
		expect(run('"abc"')).toBe("abc");
		expect(run('"a\\"b"')).toBe('a"b');
		expect(run("true")).toBe(true);
		expect(run("pi")).toBeCloseTo(Math.PI);
		expect(run("e")).toBeCloseTo(Math.E);
	});
	test("precedence and associativity", () => {
		expect(run("1 + 2 * 3")).toBe(7);
		expect(run("(1 + 2) * 3")).toBe(9);
		expect(run("10 - 4 - 3")).toBe(3);
		expect(run("100 / 10 / 5")).toBe(2);
		expect(run("2 ^ 3 ^ 2")).toBe(512);
		expect(run("-2 ^ 2")).toBe(-4);
		expect(run("2 ^ -1")).toBe(0.5);
		expect(run("7 % 4")).toBe(3);
		expect(run("1 + 2 < 4 && 2 * 2 == 4")).toBe(true);
		expect(run("!false == true")).toBe(true);
		expect(run("true || false && false")).toBe(true);
	});
	test("comparison and equality across types", () => {
		expect(run("1 < 2")).toBe(true);
		expect(run("2 <= 1")).toBe(false);
		expect(run('"a" < "b"')).toBe(true);
		expect(run('"a" == "a"')).toBe(true);
		expect(run('"1" == 1')).toBe(false);
		expect(run('"1" != 1')).toBe(true);
		expect(run('"a" < 1')).toBeNull();
	});
	test("the conditional is right-associative and short-circuits", () => {
		expect(run("1 > 2 ? 10 : 2 > 1 ? 20 : 30")).toBe(20);
		expect(run("true ? 1 : 1 / 0")).toBe(1);
		expect(run("true || missing")).toBe(true);
		expect(run("false && missing")).toBe(false);
		expect(run("1 ? 2 : 3")).toBeNull();
	});
	test("plus joins strings and numbers", () => {
		expect(run('"a" + "b"')).toBe("ab");
		expect(run('"n=" + 3')).toBe("n=3");
		expect(run('1 + "x"')).toBe("1x");
		expect(run('"v:" + true')).toBe("v:true");
		expect(run('"a" - "b"')).toBeNull();
	});
	test("names come from the scope", () => {
		expect(run("a * 2 + b", { a: 3, b: 1 })).toBe(7);
		expect(run("a", {})).toBeNull();
		expect(run("a + 1", { a: null })).toBeNull();
	});
});

describe("functions", () => {
	test("basic math", () => {
		expect(run("min(3, 1, 2)")).toBe(1);
		expect(run("max(3, 1, 2)")).toBe(3);
		expect(run("abs(-4)")).toBe(4);
		expect(run("floor(2.9)")).toBe(2);
		expect(run("ceil(2.1)")).toBe(3);
		expect(run("sqrt(16)")).toBe(4);
		expect(run("pow(2, 10)")).toBe(1024);
		expect(run("exp(0)")).toBe(1);
		expect(run("log(e)")).toBeCloseTo(1);
		expect(run("log(1000, 10)")).toBeCloseTo(3);
		expect(run("clamp(15, 0, 10)")).toBe(10);
		expect(run("clamp(-5, 0, 10)")).toBe(0);
	});
	test("round goes half away from zero and takes digits", () => {
		expect(run("round(2.5)")).toBe(3);
		expect(run("round(-2.5)")).toBe(-3);
		expect(run("round(1.005, 2)")).toBe(1.01);
		expect(run("round(1234.5678, -2)")).toBe(1200);
		expect(run("round(1.234, 1.5)")).toBeNull();
	});
	test("trigonometry works in degrees", () => {
		expect(run("sin(30)")).toBe(0.5);
		expect(run("cos(60)")).toBe(0.5);
		expect(run("cos(90)")).toBe(0);
		expect(run("tan(45)")).toBe(1);
		expect(run("tan(90)")).toBeNull();
		expect(run("asin(0.5)")).toBe(30);
		expect(run("acos(0.5)")).toBe(60);
		expect(run("atan(1)")).toBe(45);
		expect(run("atan2(1, -1)")).toBe(135);
		expect(run("asin(2)")).toBeNull();
		expect(run("atan2(0, 0)")).toBeNull();
	});
	test("pmt follows the spreadsheet sign convention", () => {
		// A 30-year loan of 200,000 at 5% a year: the payment is negative.
		expect(run("round(pmt(0.05 / 12, 360, 200000), 2)")).toBe(-1073.64);
		expect(run("pmt(0, 10, 1000)")).toBe(-100);
		expect(run("pmt(0.05, 0, 1000)")).toBeNull();
	});
	test("fv follows the spreadsheet sign convention", () => {
		// Saving 100 a month for a year at 1% a month: the future value is positive.
		expect(run("round(fv(0.01, 12, -100, 0), 2)")).toBe(1268.25);
		expect(run("round(fv(0.01, 12, -100), 2)")).toBe(1268.25);
		expect(run("fv(0, 10, -100, -500)")).toBe(1500);
		// A lump sum of 1,000 grows at 5% for 2 years.
		expect(run("round(fv(0.05, 2, 0, -1000), 2)")).toBe(1102.5);
	});
	test("series functions", () => {
		const balance: CompositionValue = [
			{ x: 40, y: 10 },
			{ x: 41, y: 20 },
			{ x: 42, y: 30 },
		];
		expect(run("last(s)", { s: balance })).toBe(30);
		expect(run("first(s)", { s: balance })).toBe(10);
		expect(run("at(s, 1)", { s: balance })).toBe(20);
		expect(run("at(s, 3)", { s: balance })).toBeNull();
		expect(run("at(s, -1)", { s: balance })).toBeNull();
		expect(run("at(s, 0.5)", { s: balance })).toBeNull();
		expect(run("sum(s)", { s: balance })).toBe(60);
		expect(run("len(s)", { s: balance })).toBe(3);
		expect(run("max(s)", { s: balance })).toBe(30);
		expect(run("last(s)", { s: [] })).toBeNull();
		expect(run("last(3)")).toBeNull();
		expect(run("s + 1", { s: balance })).toBeNull();
	});
	test("text and format", () => {
		expect(run("text(1.5)")).toBe("1.5");
		expect(run("text(0.1 + 0.2)")).toBe("0.3");
		expect(run("text(true)")).toBe("true");
		expect(run('len("abc")')).toBe(3);
		expect(run('format(1234567, "yen")')).toBe("¥1,234,567");
		expect(run('format(384400, "number")')).toBe("384,400");
		expect(run('format(1234.6, "integer")')).toBe("1,235");
		expect(run('format(3, "percent")')).toBe("3%");
		expect(run('format(1, "km")')).toBeNull();
		expect(run('format("x", "yen")')).toBeNull();
	});
	test("a null argument gives null", () => {
		expect(run("max(a, 1)", { a: null })).toBeNull();
		expect(run("sqrt(missing)")).toBeNull();
	});
});

describe("failures give null and never throw", () => {
	test.each([
		["1 / 0"],
		["5 % 0"],
		["sqrt(-1)"],
		["log(0)"],
		["log(-1)"],
		["log(8, 1)"],
		["pow(0, -1)"],
		["(-8) ^ 0.5"],
		["10 ^ 400"],
		["clamp(1, 5, 0)"],
		["1 + true"],
		["!1"],
		['-"a"'],
		["1 && 2"],
		["unknown + 1"],
	])("%s", (source) => {
		expect(run(source)).toBeNull();
	});
	test("a very large intermediate value is null, not Infinity", () => {
		expect(run("10 ^ 308 * 10")).toBeNull();
	});
});

describe("limits", () => {
	test("length", () => {
		expect(reason("1" + " ".repeat(299))).toBe("ok");
		expect(reason("1" + " ".repeat(300))).toBe("too_long");
		expect(reason("")).toBe("empty");
		expect(reason("   ")).toBe("empty");
	});
	test("depth", () => {
		expect(reason(`${"(".repeat(20)}1${")".repeat(20)}`)).toBe("ok");
		expect(reason("-".repeat(31) + "1")).toBe("ok");
		// a left-associative chain is as deep as it is long
		expect(reason("1" + "+1".repeat(31))).toBe("ok");
		expect(reason("1" + "+1".repeat(32))).toBe("too_deep");
		expect(reason("-".repeat(32) + "1")).toBe("too_deep");
		expect(reason("-".repeat(250) + "1")).toBe("too_deep");
		expect(reason(`${"max(1,".repeat(40)}1${")".repeat(40)}`)).toBe("too_deep");
	});
	test("string literals stop at 120 characters", () => {
		expect(reason(`"${"a".repeat(120)}"`)).toBe("ok");
		expect(reason(`"${"a".repeat(121)}"`)).toBe("string_too_long");
		expect(reason('"abc')).toBe("unterminated_string");
		expect(reason('"a\\n"')).toBe("bad_escape");
	});
	test("sum spends the step budget", () => {
		const points = Array.from({ length: 1200 }, (_, x) => ({ x, y: 1 }));
		const parsed = parseExpression("sum(s)");
		if (!parsed.ok) throw new Error("parse");
		const scope = {
			get: (name: string) => (name === "s" ? points : undefined),
		};
		const budget = createBudget();
		let results = 0;
		for (let n = 0; n < 20; n += 1)
			if (evaluateExpression(parsed.ast, scope, budget) === 1200) results += 1;
		expect(results).toBe(Math.floor(evaluationStepLimit / 1200));
	});
});

describe("parse results", () => {
	test("names and functions are listed once, constants excluded", () => {
		const parsed = parseExpression(
			"max(a, b) + a * pi + round(e, 2) + sqrt(c)",
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.names.sort()).toEqual(["a", "b", "c"]);
		expect(parsed.functions.sort()).toEqual(["max", "round", "sqrt"]);
	});
	test.each([
		["1 +", "unexpected_token"],
		["(1", "unexpected_token"],
		["1 2", "unexpected_token"],
		["a = 1", "unexpected_character"],
		["a & b", "unexpected_character"],
		["a ? 1", "unexpected_token"],
		["1,2", "unexpected_token"],
		["foo(1)", "unknown_function"],
		["max()", "bad_arity"],
		["sqrt(1, 2)", "bad_arity"],
		["pmt(1, 2)", "bad_arity"],
		["a.b", "unexpected_character"],
		["a[0]", "unexpected_character"],
		["x ** 2", "unexpected_token"],
		["1e999", "bad_number"],
		["日本", "unexpected_character"],
		["`a`", "unexpected_character"],
	])("%s is rejected as %s", (source, expected) => {
		expect(reason(source)).toBe(expected);
	});
});

describe("prototype names", () => {
	test.each([
		"constructor",
		"__proto__",
		"toString",
		"hasOwnProperty",
		"valueOf",
		"prototype",
	])("%s is just an unknown name", (name) => {
		const parsed = parseExpression(name === "__proto__" ? "a" : name);
		if (name === "__proto__") {
			// not a valid identifier at all
			expect(reason(name)).toBe("unexpected_character");
			return;
		}
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const map = new Map<string, CompositionValue>();
		expect(
			evaluateExpression(parsed.ast, { get: (n) => map.get(n) }),
		).toBeNull();
		expect(run(`${name} + 1`)).toBeNull();
	});
	test("function names are only called, never read from the prototype", () => {
		expect(reason("constructor(1)")).toBe("unknown_function");
		expect(reason("toString(1)")).toBe("unknown_function");
		expect(reason("hasOwnProperty(1)")).toBe("unknown_function");
	});
	test("object prototypes stay untouched", () => {
		run("constructor");
		run("toString + 1");
		expect(Object.keys(Object.prototype)).toEqual([]);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});
});

describe("cyclicNames", () => {
	test("finds names on a cycle, not those that only lead into one", () => {
		const graph = new Map<string, string[]>([
			["a", ["b"]],
			["b", ["a"]],
			["c", ["a"]],
			["d", ["d"]],
			["e", ["f", "x"]],
			["f", []],
		]);
		expect([...cyclicNames(graph)].sort()).toEqual(["a", "b", "d"]);
	});
});
