import { describe, expect, it } from "vitest";
import { evaluateExpression } from "./calculator-expression";

describe("evaluateExpression", () => {
	it.each([
		["1+2*3", 7],
		["(1+2)*3", 9],
		["2^3^2", 512],
		["-2^2", -4],
		["2^-1", 0.5],
		["8/2/2", 2],
		["0.1+0.2", 0.3],
		["2pi", 2 * Math.PI],
		["3(2+1)", 9],
		["sqrt(16)", 4],
		["1.5e3+1", 1501],
	])("%s = %s", (expression, expected) => {
		expect(evaluateExpression(expression)).toBeCloseTo(expected, 9);
	});

	it("三角関数は度数法で、90度の倍数は厳密に扱う", () => {
		expect(evaluateExpression("sin(30)")).toBeCloseTo(0.5, 12);
		expect(evaluateExpression("cos(60)")).toBeCloseTo(0.5, 12);
		expect(evaluateExpression("tan(45)")).toBe(1);
		expect(evaluateExpression("sin(180)")).toBe(0);
		expect(evaluateExpression("cos(90)")).toBe(0);
		expect(evaluateExpression("1000 * tan(89.5)")).toBeCloseTo(114588.65, 1);
	});

	it.each([
		"",
		"1+",
		"++",
		"1*-",
		"(1",
		"1)",
		"1/0",
		"sqrt(-1)",
		"tan(90)",
		"sin 30",
		"foo(1)",
		"1.2.3",
		"2 3",
		"alert(1)",
		"1; 2",
	])("%s は式として受け付けない", (expression) => {
		expect(() => evaluateExpression(expression)).toThrow();
	});

	it("長すぎる式と深すぎる入れ子を受け付けない", () => {
		expect(() => evaluateExpression("1+".repeat(300))).toThrow();
		expect(() =>
			evaluateExpression(`${"(".repeat(80)}1${")".repeat(80)}`),
		).toThrow();
	});
});
