import { expect, test } from "bun:test";
import { agencyOutputContract, llmOutputJsonSchema } from "eumenes-agency";
import { shareNullableSchemas } from "./schema";

test("transport factoring preserves the F schema when shared references are expanded", () => {
	const original = llmOutputJsonSchema(
		agencyOutputContract("update", { condition: "F", interestFormation: true })
			.schema,
	);
	const before = JSON.stringify(original);
	const factored = shareNullableSchemas(original);
	const expand = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(expand);
		if (!value || typeof value !== "object") return value;
		const node = value as Record<string, unknown>;
		if (typeof node.$ref === "string" && node.$ref.startsWith("#/$defs/"))
			return expand(
				(factored.$defs as Record<string, unknown>)[node.$ref.slice(8)],
			);
		return Object.fromEntries(
			Object.entries(node)
				.filter(([key]) => key !== "$defs")
				.map(([key, child]) => [key, expand(child)]),
		);
	};
	expect(expand(factored)).toEqual(original);
	expect(JSON.stringify(original)).toBe(before);
	expect(Object.keys(factored.$defs as object).length).toBeGreaterThan(0);
});

test("factoring preserves literals and existing definition names", () => {
	const nullable = { anyOf: [{ type: "string" }, { type: "null" }] };
	const literal = { anyOf: [{ type: "null" }] };
	const result = shareNullableSchemas({
		type: "object",
		$defs: { agencyNullable0: { type: "number" } },
		properties: { a: nullable, b: nullable, c: { const: literal } },
	});
	expect(result).toMatchObject({
		$defs: { agencyNullable0: { type: "number" }, agencyNullable1: nullable },
		properties: {
			a: { $ref: "#/$defs/agencyNullable1" },
			b: { $ref: "#/$defs/agencyNullable1" },
			c: { const: literal },
		},
	});
});
