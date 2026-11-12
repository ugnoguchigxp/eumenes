import { systemContext } from "../../../infrastructure/system-context";
import type { ChatMessage, RoutedInput } from "./context";
import { INPUT_HEADINGS, dataText, lineText } from "./input-text";
import { toolResultText } from "./result-text";

/**
 * The choice calls of a routed turn (the local harness rebuild plan, sections 4.3 and 4.4): the input they read and
 * the JSON schema their one answer is held to. The schema is built from this turn's candidates, so a choice names
 * one of them and fills only that one's fields.
 */

/** A candidate as the toolchain search returns it (`candidateOf`). */
export type ChoiceCandidate = {
	id: string;
	title: string;
	summary?: string;
	execution?: string;
	minImpact?: string;
	general?: true;
	inputs?: Record<string, unknown>;
	targets?: Array<{ ref: string; label: string }>;
};

/** What a memory request may ask (the memory tool's kinds). */
export const MEMORY_KINDS = [
	"forget",
	"remember",
	"correct",
	"goal",
	"withdraw",
] as const;

type Schema = Record<string, unknown>;
const SAY: Schema = { type: "string", minLength: 1, maxLength: 80 };
/** A request text a choice may write: within one call's output beside the thinking (the harness's limit). */
const REQUEST_CHARS = 800;
const text = (maxLength: number): Schema => ({
	type: "string",
	minLength: 1,
	maxLength,
});
const only = (value: string): Schema => ({ type: "string", enum: [value] });
const oneOf = (values: readonly string[]): Schema => ({
	type: "string",
	enum: [...values],
});
const ANY_OBJECT: Schema = { type: "object" };
/** The memory request as a candidate of the router's fill. */
export const MEMORY_REQUEST = "memory.request";
/**
 * The target a choice names for a request that makes something new: a candidate with saved items has its target
 * always filled, so a new piece is chosen as such and never left to an item the model happened to fill in.
 */
export const NEW_TARGET = "new";

/** One branch of a choice: these fields, all required but the optional ones. */
function branch(
	properties: Record<string, Schema>,
	optional: readonly string[] = [],
): Schema {
	return {
		type: "object",
		additionalProperties: false,
		required: Object.keys(properties).filter((key) => !optional.includes(key)),
		properties,
	};
}

/**
 * The branch of one candidate: an instant answer takes its inputs, any other work its request (or inputs) and `say`,
 * the resources it works on from those `## State` names, and, for a toolchain with saved items, which item it
 * changes or `new`.
 */
function candidateBranch(
	candidate: ChoiceCandidate,
	resources: readonly string[],
	switching: string | null,
	/** The branch has `say`: false when the host says its own words (the router's fill). */
	withSay = true,
): Schema {
	const choice = only(candidate.id);
	const say: Record<string, Schema> = withSay ? { say: SAY } : {};
	// An instant answer and a read tool both take their inputs alone.
	if (candidate.execution === "instant" || candidate.execution === "read")
		return branch({ choice, inputs: candidate.inputs ?? ANY_OBJECT });
	return branch(
		{
			choice,
			...say,
			request: text(REQUEST_CHARS),
			...(candidate.targets?.length
				? {
						target: oneOf([
							NEW_TARGET,
							...candidate.targets.map((target) => target.ref),
						]),
					}
				: {}),
			...(resources.length
				? { refs: { type: "array", maxItems: 8, items: oneOf(resources) } }
				: {}),
			// The user's word that the suspended unsaved work may go: the switch this hand-over waits for.
			...(candidate.id === switching
				? { resolveUnsaved: only("discard") }
				: {}),
		},
		["refs", "resolveUnsaved"],
	);
}

/** The memory request's branch: its kind, what it is about, and a detail when there is one. */
function memoryBranch(withSay = true): Schema {
	return branch(
		{
			choice: only("memory.request"),
			kind: oneOf(MEMORY_KINDS),
			what: text(500),
			detail: text(1000),
			...(withSay ? { say: SAY } : {}),
		},
		["detail"],
	);
}

/**
 * The router's fill of one candidate's fields (spec toolchain-router-redesign §3.4): none, a question back, and the
 * one branch the router decided on (without `say`: the host says its own words).
 */
export function fillSchema(
	candidate: ChoiceCandidate | ChoiceCandidate[] | typeof MEMORY_REQUEST,
	{ resources, switching }: Pick<RoutedInput, "resources" | "switching">,
): Schema {
	return {
		anyOf: [
			branch({ choice: only("none") }),
			branch({ choice: only("ask"), say: SAY }),
			...(Array.isArray(candidate)
				? candidate.map((item) =>
						candidateBranch(item, resources, switching, false),
					)
				: [
						candidate === MEMORY_REQUEST
							? memoryBranch(false)
							: candidateBranch(candidate, resources, switching, false),
					]),
		],
	};
}

/** The agent's last words, as the choice calls read them. */
function previousLine(routed: RoutedInput): string[] {
	return routed.previousReply ? [`直前の返事: ${routed.previousReply}`] : [];
}

/** The router's fill input: the records, the one candidate the router decided on, and the words. */
export function fillMessages(input: {
	style: string;
	routed: RoutedInput;
	candidate: ChoiceCandidate | ChoiceCandidate[] | typeof MEMORY_REQUEST;
	components?: readonly ChoiceCandidate[];
	utterance: string;
}): ChatMessage[] {
	const { routed } = input;
	const lines = [
		...(routed.memory ? [routed.memory] : []),
		...(routed.earlier.length
			? [INPUT_HEADINGS.earlier, ...routed.earlier.map((said) => `- ${said}`)]
			: []),
		routed.state,
		...previousLine(routed),
		...(routed.asked
			? [`聞き返した依頼: ${lineText(routed.asked.request)}`]
			: []),
		INPUT_HEADINGS.candidates,
		input.candidate === MEMORY_REQUEST
			? `- memory.request: ${systemContext("dialogue.contexts.local.memory-request", {})}`
			: toolResultText("find_toolchain", {
					candidates: Array.isArray(input.candidate)
						? input.candidate
						: [input.candidate],
				}),
		...(input.components?.length
			? [
					"## Related candidates",
					toolResultText("find_toolchain", { candidates: input.components }),
				]
			: []),
		`${INPUT_HEADINGS.user}\n${dataText(input.utterance)}`,
	];
	return [
		{
			role: "system",
			content: systemContext(
				Array.isArray(input.candidate)
					? "dialogue.contexts.local.router-work"
					: "dialogue.contexts.local.router-fill",
				{
					style: input.style,
				},
			),
		},
		{ role: "user", content: lines.join("\n") },
	];
}

/**
 * The fill of an answer to a work's question that asks for a structured answer (its input schema is not a plain
 * string): none, or the answer in that shape. The router decides that the words answer the question; the shape is
 * the conversation model's to write, as it wrote it before the router.
 */
export function answerSchema(inputSchema: Record<string, unknown>): Schema {
	return {
		anyOf: [
			branch({ choice: only("none") }),
			branch({ choice: only("answer"), answer: inputSchema }),
		],
	};
}

/** The answer fill's input: the records, the question and the shape it asks for, and the words. */
export function answerMessages(input: {
	routed: RoutedInput;
	question: string;
	inputSchema: Record<string, unknown>;
	utterance: string;
}): ChatMessage[] {
	const { routed } = input;
	return [
		{
			role: "system",
			content: systemContext("dialogue.contexts.local.router-answer-fill", {}),
		},
		{
			role: "user",
			content: [
				routed.state,
				...previousLine(routed),
				`質問: ${lineText(input.question)}`,
				`答えの形: ${JSON.stringify(input.inputSchema)}`,
				`${INPUT_HEADINGS.user}\n${dataText(input.utterance)}`,
			].join("\n"),
		},
	];
}

/**
 * A choice call's answer: the object it returned, or null when it is not one with a `choice`. A cloud provider's strict
 * form (`strictChoiceSchema`) fills every field: the ones it left null are dropped (those of the inputs too), and
 * inputs written as a JSON text are read back into their object.
 */
export function parseChoice(
	value: unknown,
): (Record<string, unknown> & { choice: string }) | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(value ?? ""));
	} catch {
		return null;
	}
	if (
		!parsed ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		typeof (parsed as { choice?: unknown }).choice !== "string"
	)
		return null;
	const chosen: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(parsed))
		if (field !== null) chosen[key] = field;
	if (typeof chosen.inputs === "string")
		try {
			chosen.inputs = JSON.parse(chosen.inputs);
		} catch {
			// Unreadable inputs are left as they are: the toolchain's own check refuses them.
		}
	if ("inputs" in chosen) chosen.inputs = withoutNulls(chosen.inputs);
	return chosen as Record<string, unknown> & { choice: string };
}

/** The inputs without the fields the strict form made the answer fill with null (the ones it left out). */
function withoutNulls(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, field]) => field !== null)
			.map(([key, field]) => [key, withoutNulls(field)]),
	);
}

/** The value types an inputs field keeps in the strict form. */
const PLAIN_TYPES = ["string", "number", "integer", "boolean"];

/**
 * One field of a candidate's inputs in the strict form: its type, its allowed values and its description. The
 * bounds stay the toolchain's own check. Null when the provider can not hold the field so.
 */
function strictInput(field: Schema): Schema | null {
	const described =
		typeof field.description === "string"
			? { description: field.description }
			: {};
	if (field.type === "object") {
		const inner = strictInputs(field);
		return inner && { ...inner, ...described };
	}
	if (field.type === "array") {
		const items =
			field.items && typeof field.items === "object"
				? strictInput(field.items as Schema)
				: null;
		return items && { type: "array", items, ...described };
	}
	if (typeof field.type !== "string" || !PLAIN_TYPES.includes(field.type))
		return null;
	return {
		type: field.type,
		...(Array.isArray(field.enum) ? { enum: field.enum } : {}),
		...described,
	};
}

/**
 * A candidate's inputs in the strict form: an object of its named fields, every one required and null when the
 * answer leaves it out, so the provider holds the answer to the fields themselves. Null when the inputs name no
 * field or hold a shape past plain values, lists and objects of them: those go as their JSON text.
 */
function strictInputs(schema: Schema): Schema | null {
	const fields = Object.entries(
		(schema.properties ?? {}) as Record<string, Schema>,
	);
	if (!fields.length) return null;
	const required = new Set(
		Array.isArray(schema.required) ? (schema.required as string[]) : [],
	);
	const properties: Record<string, Schema> = {};
	for (const [key, field] of fields) {
		const strict = strictInput(field);
		if (!strict) return null;
		properties[key] = required.has(key) ? strict : nullable(strict);
	}
	return {
		type: "object",
		additionalProperties: false,
		required: Object.keys(properties),
		properties,
	};
}

/**
 * A field in the strict form: no length ranges; a candidate's inputs as an object of their named fields, or as
 * their JSON text when the provider can not hold them strictly.
 */
function strictField(field: Schema): Schema {
	if (Array.isArray(field.anyOf))
		return { anyOf: (field.anyOf as Schema[]).map(strictField) };
	if (field.type === "object")
		return (
			strictInputs(field) ?? {
				type: "string",
				description: "選んだ担当の欄を、JSON の object の文字列で",
			}
		);
	if (field.type === "array")
		return { type: "array", items: strictField(field.items as Schema) };
	const { minLength: _min, maxLength: _max, ...rest } = field;
	return rest;
}

/** The variants of one field across the branches as one field: string enums merge, other differences become anyOf. */
function mergedField(variants: readonly Schema[]): Schema {
	const strict = variants.map(strictField);
	const strings = strict.every((v) => v.type === "string" && !v.anyOf);
	if (strings) {
		if (strict.every((v) => Array.isArray(v.enum)))
			return {
				type: "string",
				enum: [...new Set(strict.flatMap((v) => v.enum as string[]))],
			};
		if (strict.every((v) => !v.enum)) return { type: "string" };
	}
	const distinct = [
		...new Map(strict.map((v) => [JSON.stringify(v), v])).values(),
	];
	return distinct.length === 1 ? distinct[0]! : { anyOf: distinct };
}

/** A field the answer may leave out, as a strict provider needs it: required, and null when not used. */
function nullable(field: Schema): Schema {
	if (Array.isArray(field.anyOf))
		return { anyOf: [...(field.anyOf as Schema[]), { type: "null" }] };
	if (field.type === undefined || field.type === "object")
		return { anyOf: [field, { type: "null" }] };
	if (Array.isArray(field.enum))
		return {
			...field,
			type: [field.type, "null"],
			enum: [...field.enum, null],
		};
	return { ...field, type: [field.type, "null"] };
}

/**
 * A choice schema (`choiceSchema`, `pendingSchema`) in the form a cloud provider's strict structured output takes: one
 * object holding every branch's fields side by side, `choice` required, every other field required and null when the
 * choice does not use it, no additional properties and no length ranges; a candidate's inputs keep their named
 * fields (`strictInputs`). LARM keeps the branches; on the cloud the host's own checks hold what the branches held (a
 * field of another branch is refused there).
 */
export function strictChoiceSchema(schema: Schema): Schema {
	const branches = (schema.anyOf as Schema[] | undefined) ?? [schema];
	const fields = new Map<string, Schema[]>();
	for (const branch of branches)
		for (const [key, field] of Object.entries(
			(branch.properties ?? {}) as Record<string, Schema>,
		))
			fields.set(key, [...(fields.get(key) ?? []), field]);
	const properties: Record<string, Schema> = {};
	for (const [key, variants] of fields) {
		const merged = mergedField(variants);
		properties[key] = key === "choice" ? merged : nullable(merged);
	}
	return {
		type: "object",
		additionalProperties: false,
		required: [...fields.keys()],
		properties,
	};
}
