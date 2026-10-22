import type { PipelineDefinition, PipelineInput } from "../../capabilities";

/**
 * The first round fills a pipeline's inputs (spec task-pipeline-design 2026-10-22 §5): each value it gives carries
 * `<name>_quote`, a span copied from the user's request. The host checks only that the quote is in the request,
 * never what the value means. An input the user did not mention takes its default and needs no quote.
 */

export const QUOTE_SUFFIX = "_quote";
const QUOTE_MAX = 300;

/** The flat JSON Schema of the inputs, as the first round's function takes them besides the analysis. */
export function inputParameters(d: PipelineDefinition) {
	const properties: Record<string, Record<string, unknown>> = {};
	const required: string[] = [];
	for (const [name, input] of Object.entries(d.inputs)) {
		properties[name] = {
			type: input.type,
			description: input.description,
			...(input.enum ? { enum: input.enum } : {}),
			...(input.minimum !== undefined ? { minimum: input.minimum } : {}),
			...(input.maximum !== undefined ? { maximum: input.maximum } : {}),
			...(input.maxLength !== undefined ? { maxLength: input.maxLength } : {}),
		};
		properties[name + QUOTE_SUFFIX] = {
			type: "string",
			minLength: 1,
			maxLength: QUOTE_MAX,
			description: `${name}を書いたときの根拠として、利用者の依頼の原文からそのまま写した部分。言い換えない。依頼が触れていない${name}は、値も引用も書かない`,
		};
		if (input.required) required.push(name, name + QUOTE_SUFFIX);
	}
	return { type: "object", properties, required, additionalProperties: false };
}

/** Compared without spacing or width differences: a quote is the user's words, not their layout. */
function normalized(text: string) {
	return text.normalize("NFKC").replace(/\s+/g, "");
}

export type InputIssue = { path: string; code: string };

/** The inputs of the call, checked against the definition and the request; defaults fill what was not said. */
export function parseInputs(
	d: PipelineDefinition,
	args: Record<string, unknown>,
	request: string,
):
	| { ok: true; value: Record<string, unknown> }
	| { ok: false; issues: InputIssue[] } {
	const issues: InputIssue[] = [];
	const names = new Set(Object.keys(d.inputs));
	for (const key of Object.keys(args)) {
		const base = key.endsWith(QUOTE_SUFFIX)
			? key.slice(0, -QUOTE_SUFFIX.length)
			: key;
		if (!names.has(base)) issues.push({ path: key, code: "unrecognized_key" });
	}
	const said = normalized(request);
	const value: Record<string, unknown> = {};
	for (const [name, input] of Object.entries(d.inputs)) {
		const given = args[name];
		const quote = args[name + QUOTE_SUFFIX];
		if (given === undefined || given === null) {
			if (input.required) issues.push({ path: name, code: "required" });
			else if (input.default !== undefined) value[name] = input.default;
			continue;
		}
		const fault = valueFault(input, given);
		if (fault) issues.push({ path: name, code: fault });
		if (typeof quote !== "string" || !quote.trim() || quote.length > QUOTE_MAX)
			issues.push({ path: name + QUOTE_SUFFIX, code: "required" });
		// A quote is the user's words: punctuation alone quotes nothing.
		else if (!/[\p{L}\p{N}]/u.test(quote) || !said.includes(normalized(quote)))
			issues.push({ path: name + QUOTE_SUFFIX, code: "quote_not_in_request" });
		value[name] = given;
	}
	return issues.length ? { ok: false, issues } : { ok: true, value };
}

function valueFault(input: PipelineInput, v: unknown): string | null {
	if (input.type === "string") {
		if (typeof v !== "string" || !v.trim()) return "invalid_type";
		if (v.length > (input.maxLength ?? 500)) return "too_big";
		if (input.enum && !input.enum.includes(v)) return "invalid_value";
		return null;
	}
	if (input.type === "boolean")
		return typeof v === "boolean" ? null : "invalid_type";
	if (typeof v !== "number" || !Number.isFinite(v)) return "invalid_type";
	if (input.type === "integer" && !Number.isInteger(v)) return "invalid_type";
	if (input.minimum !== undefined && v < input.minimum) return "too_small";
	if (input.maximum !== undefined && v > input.maximum) return "too_big";
	return null;
}
