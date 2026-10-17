import { z } from "zod";
import { ValidationFailure } from "../../../infrastructure/validation-log";
import { bytes, type JsonSchema } from "../contracts";
const types = [
	"object",
	"array",
	"string",
	"number",
	"integer",
	"boolean",
	"null",
];
const keys: Record<string, string[]> = {
	object: ["properties", "required", "additionalProperties"],
	array: ["items", "minItems", "maxItems"],
	string: ["minLength", "maxLength", "format"],
	number: ["minimum", "maximum"],
	integer: ["minimum", "maximum"],
	boolean: [],
	null: [],
};
/** Only the reason is reported: schema keys and values are model text and are never copied. */
const fail = (reason: string, limit?: number): never => {
	throw new ValidationFailure("invalid_requirement_schema", [
		{
			validationPath: "valueSchema",
			validationCode: reason,
			...(limit === undefined ? {} : { limit }),
		},
	]);
};
/** Reject unsupported keywords before Zod conversion; never interpret or execute schema text. */
export function validateRequirementSchema(schema: JsonSchema) {
	if (bytes(schema) > 4096) fail("too_big", 4096);
	let nodes = 0;
	function visit(raw: unknown, depth: number) {
		if (depth > 6) fail("too_deep", 6);
		if (++nodes > 128) fail("too_many_nodes", 128);
		if (!raw || typeof raw !== "object" || Array.isArray(raw))
			fail("schema_not_object");
		const s = raw as JsonSchema,
			rawType = s.type;
		const t = rawType as string;
		if (typeof t !== "string" || !types.includes(t)) fail("unsupported_type");
		if (
			Object.keys(s).some(
				(k) => !["type", "description", "enum", ...keys[t]!].includes(k),
			)
		)
			fail("unsupported_keyword");
		if (
			s.description !== undefined &&
			(typeof s.description !== "string" || s.description.length > 500)
		)
			fail("invalid_description", 500);
		if (s.enum !== undefined) {
			if (
				["object", "array"].includes(t) ||
				!Array.isArray(s.enum) ||
				!s.enum.length ||
				s.enum.length > 32
			)
				fail("invalid_enum", 32);
			if (
				(s.enum as unknown[]).some((v) =>
					t === "null"
						? v !== null
						: t === "integer"
							? typeof v !== "number" || !Number.isInteger(v)
							: typeof v !== t ||
								(typeof v === "number" && !Number.isFinite(v)),
				)
			)
				fail("enum_type_mismatch");
		}
		const bound = (
			key: string,
			max = Number.MAX_SAFE_INTEGER,
			required = false,
		) => {
			const v = s[key];
			if (v === undefined && !required) return;
			if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max)
				fail("invalid_bound");
		};
		if (t === "object") {
			if (
				!s.properties ||
				typeof s.properties !== "object" ||
				Array.isArray(s.properties) ||
				s.additionalProperties !== false
			)
				fail("invalid_properties");
			const entries = Object.entries(s.properties as Record<string, unknown>);
			if (
				entries.length > 32 ||
				entries.some(
					([k]) =>
						!k.length ||
						k.length > 64 ||
						["__proto__", "prototype", "constructor"].includes(k),
				)
			)
				fail("invalid_property_names", 32);
			if (
				s.required !== undefined &&
				(!Array.isArray(s.required) ||
					new Set(s.required).size !== s.required.length ||
					s.required.some(
						(k) =>
							typeof k !== "string" ||
							!Object.hasOwn(s.properties as object, k),
					))
			)
				fail("invalid_required");
			for (const [, v] of entries) visit(v, depth + 1);
		}
		if (t === "array") {
			bound("minItems", 32);
			bound("maxItems", 32, true);
			if (Number(s.minItems ?? 0) > Number(s.maxItems)) fail("invalid_range");
			visit(s.items, depth + 1);
		}
		if (t === "string") {
			bound("minLength");
			bound("maxLength");
			if (
				s.maxLength !== undefined &&
				Number(s.minLength ?? 0) > Number(s.maxLength)
			)
				fail("invalid_range");
			if (
				s.format !== undefined &&
				!["date", "date-time", "uri"].includes(String(s.format))
			)
				fail("unsupported_format");
		}
		if (t === "number" || t === "integer") {
			for (const k of ["minimum", "maximum"])
				if (
					s[k] !== undefined &&
					(typeof s[k] !== "number" || !Number.isFinite(s[k]))
				)
					fail("invalid_bound");
			if (
				s.minimum !== undefined &&
				s.maximum !== undefined &&
				Number(s.minimum) > Number(s.maximum)
			)
				fail("invalid_range");
		}
	}
	visit(schema, 1);
	// Zod's enum conversion returns early and drops the node's other constraints.
	// Compose both schemas, including nested nodes, after checking the public subset.
	function conversion(s: JsonSchema): JsonSchema {
		const { enum: values, ...typed } = s;
		if (typed.type === "object")
			typed.properties = Object.fromEntries(
				Object.entries(typed.properties as Record<string, JsonSchema>).map(
					([key, child]) => [key, conversion(child)],
				),
			);
		if (typed.type === "array")
			typed.items = conversion(typed.items as JsonSchema);
		return values === undefined ? typed : { allOf: [typed, { enum: values }] };
	}
	try {
		return z.fromJSONSchema(
			conversion(schema) as Parameters<typeof z.fromJSONSchema>[0],
		);
	} catch {
		return fail("conversion_failed");
	}
}
export function requirementValueMatches(schema: JsonSchema, value: unknown) {
	if (bytes(value) > 4096) return false;
	return validateRequirementSchema(schema).safeParse(value).success;
}
