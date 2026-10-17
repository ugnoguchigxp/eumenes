import { expect, test } from "bun:test";
import { formatCompositionValue } from "./composition-format";

test("numbers use ja-JP grouping and at most two decimals by default", () => {
	expect(formatCompositionValue(384400)).toBe("384,400");
	expect(formatCompositionValue(3.14159)).toBe("3.14");
	expect(formatCompositionValue(2.5, { decimals: 2 })).toBe("2.50");
	expect(formatCompositionValue(1234.5678, { format: "integer" })).toBe(
		"1,235",
	);
});

test("yen carries the sign and thousands separators", () => {
	expect(formatCompositionValue(1234567, { format: "yen" })).toBe("¥1,234,567");
	expect(formatCompositionValue(-1500, { format: "yen" })).toBe("-¥1,500");
	expect(formatCompositionValue(99.6, { format: "yen" })).toBe("¥100");
	expect(formatCompositionValue(0.4, { format: "yen", decimals: 1 })).toBe(
		"¥0.4",
	);
});

test("percent shows the value as it is", () => {
	expect(formatCompositionValue(3, { format: "percent" })).toBe("3%");
	expect(
		formatCompositionValue(3.456, { format: "percent", decimals: 1 }),
	).toBe("3.5%");
});

test("a value that rounds to zero loses its minus sign", () => {
	expect(formatCompositionValue(-0.001)).toBe("0");
	expect(formatCompositionValue(-0.001, { format: "yen" })).toBe("¥0");
});

test("the unit follows the value, with a space before a Latin unit", () => {
	expect(formatCompositionValue(384400, { unit: "km" })).toBe("384,400 km");
	expect(formatCompositionValue(65, { format: "integer", unit: "歳" })).toBe(
		"65歳",
	);
});

test("invalid values show a dash", () => {
	for (const value of [null, undefined, Number.NaN, Infinity, [{ x: 1, y: 2 }]])
		expect(formatCompositionValue(value as never, { format: "yen" })).toBe("—");
	expect(formatCompositionValue("abc", { format: "number" })).toBe("—");
});

test("text and booleans are shown as they read", () => {
	expect(formatCompositionValue("見積もり")).toBe("見積もり");
	expect(formatCompositionValue(true)).toBe("はい");
});
