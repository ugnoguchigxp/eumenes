import { expect, test } from "bun:test";
import {
	compileJsonSchemaSubset,
	UnsupportedSchema,
} from "../service/json-schema-subset";

const reason = (schema: Record<string, unknown>) => {
	try {
		compileJsonSchemaSubset(schema);
	} catch (e) {
		if (e instanceof UnsupportedSchema) return `${e.path}:${e.reason}`;
		throw e;
	}
	return null;
};

test("the finite subset becomes a strict validator with the stated bounds", () => {
	const zod = compileJsonSchemaSubset({
		type: "object",
		additionalProperties: false,
		required: ["name", "count"],
		properties: {
			name: { type: "string", minLength: 1, maxLength: 5 },
			count: { type: "integer", minimum: 1, maximum: 3 },
			ratio: { type: "number", minimum: 0, maximum: 1 },
			mode: { type: "string", enum: ["a", "b"] },
			level: { type: "integer", enum: [1, 2] },
			on: { type: "boolean" },
			tags: { type: "array", items: { type: "string" }, maxItems: 2 },
		},
	});
	expect(zod.safeParse({ name: "ab", count: 2 }).success).toBe(true);
	expect(
		zod.safeParse({
			name: "ab",
			count: 2,
			ratio: 0.5,
			mode: "a",
			level: 2,
			on: true,
			tags: ["x"],
		}).success,
	).toBe(true);
	for (const bad of [
		{ name: "", count: 2 },
		{ name: "abcdef", count: 2 },
		{ name: "ab", count: 4 },
		{ name: "ab", count: 1.5 },
		{ name: "ab", count: 2, mode: "c" },
		{ name: "ab", count: 2, level: 3 },
		{ name: "ab", count: 2, tags: ["1", "2", "3"] },
		{ name: "ab", count: 2, extra: 1 },
		{ count: 2 },
	])
		expect(zod.safeParse(bad).success).toBe(false);
});

test("anything outside the subset is refused with its path, never dropped", () => {
	const object = (properties: Record<string, unknown>) => ({
		type: "object",
		additionalProperties: false,
		properties,
	});
	expect(reason({ type: "string" })).toBe(":top_level");
	expect(reason({ type: "object", properties: {} })).toBe(
		":additionalProperties",
	);
	expect(reason({ ...object({}), $ref: "#/x" })).toBe(":keyword:$ref");
	expect(reason(object({ a: { type: "string", pattern: "^a" } }))).toBe(
		"/properties/a:keyword:pattern",
	);
	expect(reason(object({ a: { type: "string", format: "uri" } }))).toBe(
		"/properties/a:keyword:format",
	);
	for (const keyword of ["oneOf", "anyOf", "allOf", "not", "if", "then"])
		expect(reason(object({ a: { type: "string", [keyword]: [] } }))).toBe(
			`/properties/a:keyword:${keyword}`,
		);
	expect(reason(object({ a: { oneOf: [{ type: "string" }] } }))).toBe(
		"/properties/a:type",
	);
	expect(reason(object({ a: { type: "array" } }))).toBe(
		"/properties/a:missing:items",
	);
	expect(
		reason(object({ a: { type: "string", minLength: 3, maxLength: 1 } })),
	).toBe("/properties/a:value:range");
	expect(reason(object({ a: { type: "integer", enum: [1.5] } }))).toBe(
		"/properties/a:value:enum",
	);
	expect(
		reason({ ...object({ a: { type: "string" } }), required: ["b"] }),
	).toBe(":value:required");
	expect(reason(object({ "bad name": { type: "string" } }))).toBe(
		"/properties/bad name:name",
	);
});
