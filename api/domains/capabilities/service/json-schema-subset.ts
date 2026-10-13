import { z } from "zod";

/**
 * The finite JSON Schema subset a bundle may ship (spec 2026-10-13 §5.1): objects with explicit
 * properties, strings, numbers, integers, booleans, enums and arrays, each with explicit sizes
 * and ranges. Everything else (`$ref`, `pattern`, `format`, unions, conditions, unknown
 * keywords) is rejected with its path; nothing is silently dropped, so the host validator, the UI
 * input and the schema shown to a model all agree.
 */
export class UnsupportedSchema extends Error {
	constructor(
		readonly path: string,
		readonly reason: string,
	) {
		super("unsupported_schema");
	}
}

const MAX_DEPTH = 6;
const MAX_PROPERTIES = 64;
const MAX_ENUM = 64;
const annotations = ["title", "description"];
const propertyName = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === "object" && !Array.isArray(v);

function keywords(
	node: Record<string, unknown>,
	allowed: string[],
	path: string,
) {
	for (const key of Object.keys(node))
		if (!allowed.includes(key) && !annotations.includes(key))
			throw new UnsupportedSchema(path, `keyword:${key}`);
	for (const key of annotations)
		if (key in node && typeof node[key] !== "string")
			throw new UnsupportedSchema(path, `keyword:${key}`);
}
function count(
	node: Record<string, unknown>,
	key: string,
	path: string,
	max: number,
) {
	const v = node[key];
	if (v === undefined) return undefined;
	if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max)
		throw new UnsupportedSchema(path, `value:${key}`);
	return v;
}
function bound(node: Record<string, unknown>, key: string, path: string) {
	const v = node[key];
	if (v === undefined) return undefined;
	if (typeof v !== "number" || !Number.isFinite(v))
		throw new UnsupportedSchema(path, `value:${key}`);
	return v;
}
function literals(
	node: Record<string, unknown>,
	path: string,
	accepts: (v: unknown) => v is string | number,
) {
	const v = node.enum;
	if (v === undefined) return undefined;
	if (
		!Array.isArray(v) ||
		!v.length ||
		v.length > MAX_ENUM ||
		!v.every(accepts) ||
		new Set(v).size !== v.length
	)
		throw new UnsupportedSchema(path, "value:enum");
	return v as (string | number)[];
}
function ordered(lo: number | undefined, hi: number | undefined, path: string) {
	if (lo !== undefined && hi !== undefined && lo > hi)
		throw new UnsupportedSchema(path, "value:range");
}

function convert(node: unknown, path: string, depth: number): z.ZodType {
	if (!isRecord(node)) throw new UnsupportedSchema(path, "not_object");
	if (depth > MAX_DEPTH) throw new UnsupportedSchema(path, "depth");
	let out: z.ZodType;
	switch (node.type) {
		case "string": {
			keywords(node, ["type", "minLength", "maxLength", "enum"], path);
			const values = literals(
				node,
				path,
				(v): v is string => typeof v === "string",
			);
			const min = count(node, "minLength", path, 100_000);
			const max = count(node, "maxLength", path, 100_000);
			ordered(min, max, path);
			if (values) {
				if (
					values.some(
						(v) =>
							(min !== undefined && String(v).length < min) ||
							(max !== undefined && String(v).length > max),
					)
				)
					throw new UnsupportedSchema(path, "value:enum");
				out = z.enum(values as [string, ...string[]]);
			} else {
				let s = z.string();
				if (min !== undefined) s = s.min(min);
				if (max !== undefined) s = s.max(max);
				out = s;
			}
			break;
		}
		case "number":
		case "integer": {
			keywords(node, ["type", "minimum", "maximum", "enum"], path);
			const values = literals(
				node,
				path,
				(v): v is number =>
					typeof v === "number" &&
					Number.isFinite(v) &&
					(node.type === "number" || Number.isInteger(v)),
			);
			const min = bound(node, "minimum", path);
			const max = bound(node, "maximum", path);
			ordered(min, max, path);
			if (values) {
				if (
					values.some(
						(v) =>
							(min !== undefined && (v as number) < min) ||
							(max !== undefined && (v as number) > max),
					)
				)
					throw new UnsupportedSchema(path, "value:enum");
				const items = values.map((v) => z.literal(v));
				out = items.length === 1 ? items[0]! : z.union(items as never);
			} else {
				let n = node.type === "integer" ? z.number().int() : z.number();
				if (min !== undefined) n = n.min(min);
				if (max !== undefined) n = n.max(max);
				out = n;
			}
			break;
		}
		case "boolean":
			keywords(node, ["type"], path);
			out = z.boolean();
			break;
		case "array": {
			keywords(node, ["type", "items", "minItems", "maxItems"], path);
			if (node.items === undefined)
				throw new UnsupportedSchema(path, "missing:items");
			const min = count(node, "minItems", path, 1000);
			const max = count(node, "maxItems", path, 1000);
			ordered(min, max, path);
			let a = z.array(convert(node.items, `${path}/items`, depth + 1));
			if (min !== undefined) a = a.min(min);
			if (max !== undefined) a = a.max(max);
			out = a;
			break;
		}
		case "object": {
			keywords(
				node,
				["type", "properties", "required", "additionalProperties"],
				path,
			);
			if (node.additionalProperties !== false)
				throw new UnsupportedSchema(path, "additionalProperties");
			if (!isRecord(node.properties))
				throw new UnsupportedSchema(path, "missing:properties");
			const names = Object.keys(node.properties);
			if (names.length > MAX_PROPERTIES)
				throw new UnsupportedSchema(path, "value:properties");
			const required = node.required ?? [];
			if (
				!Array.isArray(required) ||
				required.some((r) => typeof r !== "string" || !names.includes(r)) ||
				new Set(required).size !== required.length
			)
				throw new UnsupportedSchema(path, "value:required");
			const shape: Record<string, z.ZodType> = {};
			for (const name of names) {
				if (!propertyName.test(name))
					throw new UnsupportedSchema(`${path}/properties/${name}`, "name");
				const child = convert(
					node.properties[name],
					`${path}/properties/${name}`,
					depth + 1,
				);
				shape[name] = required.includes(name) ? child : child.optional();
			}
			out = z.strictObject(shape);
			break;
		}
		default:
			throw new UnsupportedSchema(path, "type");
	}
	return typeof node.description === "string"
		? out.describe(node.description)
		: out;
}

/** Zod validator of a schema in the subset; throws `UnsupportedSchema` with the path otherwise. */
export function compileJsonSchemaSubset(schema: Record<string, unknown>) {
	if (schema.type !== "object") throw new UnsupportedSchema("", "top_level");
	return convert(schema, "", 0);
}
