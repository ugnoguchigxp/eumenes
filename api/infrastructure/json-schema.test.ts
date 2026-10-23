import { expect, test } from "bun:test";
import { mapJsonSchema } from "./json-schema";

test("schema keywords are traversed while keyword-shaped literal data and property names are preserved", () => {
	const literal = {
		type: "string",
		minLength: 2,
		maxLength: 2000,
		$ref: "#/data",
		$schema: "data",
	};
	const source = {
		properties: {
			$schema: { type: "string" },
			properties: { type: "string" },
			payload: {
				const: literal,
				default: literal,
				examples: [literal],
				enum: [literal],
			},
		},
		$defs: { child: { type: "string", maxLength: 2000 } },
		items: { anyOf: [{ type: "string", maxLength: 2000 }, false] },
	};
	const projected = mapJsonSchema(source, (schema) => {
		const result = { ...schema };
		delete result.maxLength;
		return result;
	});
	expect(projected).toEqual({
		...source,
		$defs: { child: { type: "string" } },
		items: { anyOf: [{ type: "string" }, false] },
	});
	expect(source.$defs.child.maxLength).toBe(2000);
});
