import type {
	NativeTool,
	NativeToolCall,
} from "../../../infrastructure/chat-stream";
import { parseLlmJson } from "../../../infrastructure/llm-json";
import type { ControlContract, Receipt, Messages } from "./index";
import { systemContext } from "../../../infrastructure/system-context";
import { mapJsonSchema } from "../../../infrastructure/json-schema";

type Schema = Record<string, unknown>;

/** Strict providers require optional properties to be present as null. Keep the source schema for decoding. */
function strictSchema(value: unknown, referenceRoot: string): unknown {
	return mapJsonSchema(value, (source) => {
		const { $schema: _schema, ...result } = source;
		if (typeof source.$ref === "string" && source.$ref.startsWith("#"))
			result.$ref = referenceRoot + source.$ref.slice(1);
		if (source.properties && typeof source.properties === "object") {
			const required = new Set(
				Array.isArray(source.required) ? source.required : [],
			);
			result.properties = Object.fromEntries(
				Object.entries(source.properties).map(([key, item]) => [
					key,
					required.has(key) ? item : { anyOf: [item, { type: "null" }] },
				]),
			);
			result.required = Object.keys(source.properties);
		}
		return result;
	});
}

/** The same offered functions and argument contracts, expressed as one schema-constrained choice. */
export function operationOutputContract(
	tools: readonly NativeTool[],
): ControlContract {
	if (!tools.length) throw new Error("operation_tools_missing");
	return {
		instructions: systemContext(
			"inference.contexts.operation-output.instruction",
			{},
		),
		outputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["call"],
			properties: {
				call: {
					anyOf: tools.map(({ function: tool }, index) => ({
						type: "object",
						additionalProperties: false,
						required: ["name", "arguments"],
						description: tool.description,
						properties: {
							name: { type: "string", enum: [tool.name] },
							arguments: strictSchema(
								tool.parameters,
								`#/properties/call/anyOf/${index}/properties/arguments`,
							),
						},
					})),
				},
			},
		},
	};
}

/** A grammar alone does not make descriptions visible; some deployed templates also drop later system messages. */
export function operationOutputMessages(
	messages: Messages,
	contract: ControlContract,
): Messages {
	const content =
		contract.instructions +
		"\nOUTPUT_SCHEMA=" +
		JSON.stringify(contract.outputSchema);
	if (messages[0]?.role === "system")
		return [
			{ ...messages[0], content: messages[0].content + "\n" + content },
			...messages.slice(1),
		];
	return [{ role: "system", content }, ...messages];
}

function resolved(schema: Schema | boolean, root: Schema | boolean): Schema {
	if (schema === false) return { enum: [] };
	if (!schema || typeof schema !== "object") return {};
	const seen = new Set<string>();
	while (
		typeof schema.$ref === "string" &&
		(schema.$ref === "#" || schema.$ref.startsWith("#/"))
	) {
		if (seen.has(schema.$ref)) return {};
		seen.add(schema.$ref);
		let target: unknown = root;
		for (const key of schema.$ref === "#"
			? []
			: schema.$ref.slice(2).split("/"))
			target =
				target && typeof target === "object"
					? (target as Schema)[key.replaceAll("~1", "/").replaceAll("~0", "~")]
					: undefined;
		if (target === false) return { enum: [] };
		if (target === true) target = {};
		if (!target || typeof target !== "object") return schema;
		const { $ref: _ref, ...siblings } = schema;
		schema = { ...target, ...siblings };
	}
	return schema;
}

function nullable(source: Schema | boolean, root: Schema | boolean): boolean {
	const schema = resolved(source, root);
	if ("const" in schema) return schema.const === null;
	if (Array.isArray(schema.enum)) return schema.enum.includes(null);
	if (!schema.type && !schema.anyOf && !schema.oneOf) return true;
	return (
		schema.type === "null" ||
		(Array.isArray(schema.type) && schema.type.includes("null")) ||
		["anyOf", "oneOf"].some(
			(key) =>
				Array.isArray(schema[key]) &&
				(schema[key] as Schema[]).some((s) => nullable(s, root)),
		)
	);
}

/** Undo only the optional-null representation; actual nullable fields and required values are untouched. */
function sourceArguments(
	value: unknown,
	source: Schema | boolean,
	root = source,
): unknown {
	const schema = resolved(source, root);
	const branches = schema.anyOf ?? schema.oneOf;
	if (Array.isArray(branches)) {
		// Resolve representation only when structural branches agree; ambiguity remains for the owning validator.
		const candidates = (branches as Schema[])
			.filter((branch) => shapeMatches(value, resolved(branch, root)))
			.map((branch) => sourceArguments(value, branch, root));
		if (
			candidates.length &&
			candidates.every(
				(candidate) =>
					JSON.stringify(candidate) === JSON.stringify(candidates[0]),
			)
		)
			return candidates[0];
		return value;
	}
	if (Array.isArray(value))
		return value.map((item) =>
			sourceArguments(item, (schema.items ?? {}) as Schema, root),
		);
	if (!value || typeof value !== "object") return value;
	const properties = (schema.properties ?? {}) as Record<string, Schema>;
	const required = new Set(
		Array.isArray(schema.required) ? schema.required : [],
	);
	return Object.fromEntries(
		Object.entries(value)
			.filter(
				([key, item]) =>
					!(
						item === null &&
						Object.hasOwn(properties, key) &&
						!required.has(key) &&
						!nullable(properties[key]!, root)
					),
			)
			.map(([key, item]) => [
				key,
				sourceArguments(
					item,
					properties[key] ??
						(typeof schema.additionalProperties === "object"
							? (schema.additionalProperties as Schema)
							: {}),
					root,
				),
			]),
	);
}

/** JSON structure discriminators only, never the operation's business meaning. */
function shapeMatches(value: unknown, schema: Schema): boolean {
	if (
		"const" in schema &&
		JSON.stringify(schema.const) !== JSON.stringify(value)
	)
		return false;
	if (
		Array.isArray(schema.enum) &&
		!schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))
	)
		return false;
	const type =
		value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
	if (
		schema.type &&
		!(Array.isArray(schema.type) ? schema.type : [schema.type]).some(
			(t) =>
				t === type ||
				(t === "integer" &&
					typeof value === "number" &&
					Number.isInteger(value)),
		)
	)
		return false;
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const object = value as Schema;
		const properties = (schema.properties ?? {}) as Record<string, Schema>;
		if (
			Array.isArray(schema.required) &&
			schema.required.some((key) => typeof key === "string" && !(key in object))
		)
			return false;
		if (
			Object.entries(properties).some(
				([key, child]) =>
					key in object &&
					child &&
					typeof child === "object" &&
					("const" in child || "enum" in child) &&
					!shapeMatches(object[key], child),
			)
		)
			return false;
	}
	return true;
}

/** Representation conversion only. Business/permission checks still run in the caller's existing validator. */
export function operationOutputReceipt(
	receipt: Receipt,
	tools: readonly NativeTool[],
): Receipt {
	// A port may already expose its normalized function choice (e.g. an SDK/test port).
	if (receipt.toolCalls?.length) return receipt;
	const output = parseLlmJson(receipt.value, 131_072) as { call?: unknown };
	if (
		!output ||
		typeof output !== "object" ||
		Array.isArray(output) ||
		Object.keys(output).some((k) => k !== "call")
	)
		throw new Error("operation_output_invalid");
	const call = output.call as
		| { name?: unknown; arguments?: unknown }
		| undefined;
	if (
		!call ||
		typeof call !== "object" ||
		Array.isArray(call) ||
		typeof call.name !== "string" ||
		!call.arguments ||
		typeof call.arguments !== "object" ||
		Array.isArray(call.arguments) ||
		Object.keys(call).some((k) => k !== "name" && k !== "arguments")
	)
		throw new Error("operation_output_invalid");
	const tool = tools.find((t) => t.function.name === call.name);
	const normalized: NativeToolCall = {
		id: crypto.randomUUID(),
		name: call.name,
		arguments: JSON.stringify(
			tool
				? sourceArguments(call.arguments, tool.function.parameters)
				: call.arguments,
		),
	};
	return { ...receipt, value: "", toolCalls: [normalized] };
}
