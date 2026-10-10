import { test, expect } from "bun:test";
import { validateRequirementSchema, requirementValueMatches } from "..";
test("enum values must also satisfy bounds and formats at every nested node", () => {
	const number = { type: "number", enum: [-1, 5, 11], minimum: 0, maximum: 10 };
	expect(requirementValueMatches(number, 5)).toBe(true);
	for (const value of [-1, 11, 6])
		expect(requirementValueMatches(number, value)).toBe(false);
	const string = {
		type: "string",
		enum: ["a", "ok", "long"],
		minLength: 2,
		maxLength: 3,
	};
	expect(requirementValueMatches(string, "ok")).toBe(true);
	for (const value of ["a", "long"])
		expect(requirementValueMatches(string, value)).toBe(false);
	const date = {
		type: "string",
		format: "date-time",
		maxLength: 40,
		enum: ["not-a-date", "2026-10-10T00:00:00Z"],
	};
	expect(requirementValueMatches(date, "not-a-date")).toBe(false);
	expect(requirementValueMatches(date, "2026-10-10T00:00:00Z")).toBe(true);
	const nested = {
		type: "object",
		properties: { values: { type: "array", items: number, maxItems: 2 } },
		required: ["values"],
		additionalProperties: false,
	};
	expect(requirementValueMatches(nested, { values: [5] })).toBe(true);
	expect(requirementValueMatches(nested, { values: [-1] })).toBe(false);
});
test("R04 unsupported keywords, incompatible keywords and resource limits reject before conversion", () => {
	for (const s of [
		{ type: "string", maxLength: 40, pattern: "secret" },
		{ type: "string", maxLength: 40, format: "email" },
		{ type: "string", maxLength: 40, $ref: "https://example.org/schema" },
		{ type: "number", maxLength: 5 },
		{ type: "array", items: { type: "boolean" }, maxItems: 33 },
		{
			type: "object",
			properties: JSON.parse('{"__proto__":{"type":"boolean"}}'),
			additionalProperties: false,
		},
		{ type: "integer", enum: [1.5] },
	])
		expect(() => validateRequirementSchema(s)).toThrow(
			"invalid_requirement_schema",
		);
	let deep: Record<string, unknown> = { type: "boolean" };
	for (let i = 0; i < 6; i++)
		deep = { type: "array", maxItems: 1, items: deep };
	expect(() => validateRequirementSchema(deep)).toThrow();
});
test("R05 standard schema conversion is strict and does not coerce, default or ignore fields", () => {
	const schema = {
		type: "object",
		properties: {
			amount: { type: "number", minimum: 0 },
			currency: { type: "string", maxLength: 16, enum: ["JPY", "USD"] },
		},
		required: ["amount", "currency"],
		additionalProperties: false,
	};
	expect(
		requirementValueMatches(schema, { amount: 1500, currency: "JPY" }),
	).toBe(true);
	for (const value of [
		{ amount: -1, currency: "JPY" },
		{ amount: "1500", currency: "JPY" },
		{ amount: 0 },
		{ amount: 0, currency: "EUR" },
		{ amount: 0, currency: "JPY", extra: 1 },
	])
		expect(requirementValueMatches(schema, value)).toBe(false);
	const time = { type: "string", format: "date-time", maxLength: 40 };
	expect(requirementValueMatches(time, "2026-10-15T09:00:00Z")).toBe(true);
	expect(requirementValueMatches(time, "2026-10-15T18:00:00+09:00")).toBe(
		false,
	);
});
