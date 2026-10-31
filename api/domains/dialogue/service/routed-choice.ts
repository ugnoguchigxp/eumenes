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
): Schema {
	const choice = only(candidate.id);
	// An instant answer and a read tool both take their inputs alone.
	if (candidate.execution === "instant" || candidate.execution === "read")
		return branch({ choice, inputs: candidate.inputs ?? ANY_OBJECT });
	if (candidate.execution === "pipeline")
		return branch({ choice, say: SAY, inputs: candidate.inputs ?? ANY_OBJECT });
	return branch(
		{
			choice,
			say: SAY,
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

/**
 * The request turn's schema: none, a question back, one branch per candidate (but those `excluded`; a read tool the
 * search offered is one), the memory request, and a correction or cancellation of each open TODO.
 */
export function choiceSchema(
	candidates: readonly ChoiceCandidate[],
	{
		todos,
		resources,
		switching,
	}: Pick<RoutedInput, "todos" | "resources" | "switching">,
	excluded: ReadonlySet<string> = new Set(),
): Schema {
	return {
		anyOf: [
			branch({ choice: only("none") }),
			branch({ choice: only("ask"), say: SAY }),
			...candidates
				.filter((candidate) => !excluded.has(candidate.id))
				.map((candidate) => candidateBranch(candidate, resources, switching)),
			branch(
				{
					choice: only("memory.request"),
					kind: oneOf(MEMORY_KINDS),
					what: text(500),
					detail: text(1000),
					say: SAY,
				},
				["detail"],
			),
			...(todos.length
				? [
						branch({
							choice: oneOf(todos.map((todo) => `t${todo.ref}`)),
							operation: only("check"),
						}),
					]
				: []),
			...todos
				.filter((todo) => todo.open)
				.map((todo) =>
					branch(
						{
							choice: only(`t${todo.ref}`),
							operation: oneOf(["amend", "cancel"]),
							text: text(8000),
							say: SAY,
						},
						["text"],
					),
				),
		],
	};
}

/** The pending turn's schema: none, an answer to a confirmation, or an answer to a work's question. */
export function pendingSchema(pending: RoutedInput["pending"]): Schema {
	const confirmations = pending.confirmations.map((c) => `c${c.ref}`);
	const questions = pending.questions.map((q) => `t${q.ref}`);
	return {
		anyOf: [
			branch({ choice: only("none") }),
			...(confirmations.length
				? [
						branch({
							choice: oneOf(["approve", "decline"]),
							confirmation: oneOf(confirmations),
						}),
					]
				: []),
			...(questions.length
				? [
						branch({
							choice: only("answer"),
							todo: oneOf(questions),
							text: text(8000),
						}),
					]
				: []),
		],
	};
}

/** The agent's last words, as the choice calls read them. */
function previousLine(routed: RoutedInput): string[] {
	return routed.previousReply ? [`直前の返事: ${routed.previousReply}`] : [];
}

/** The request turn's input: the role, then the records, the candidates and the host's operations, and the words. */
export function choiceMessages(input: {
	style: string;
	routed: RoutedInput;
	candidates: readonly ChoiceCandidate[];
	utterance: string;
	excluded?: ReadonlySet<string>;
	/** Why the last choice could not be carried out, for the one retry. */
	retry?: string;
}): ChatMessage[] {
	const { routed } = input;
	const shown = input.candidates.filter(
		(candidate) => !input.excluded?.has(candidate.id),
	);
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
		...(shown.length
			? [toolResultText("find_toolchain", { candidates: shown })]
			: []),
		`- memory.request: ${systemContext("dialogue.contexts.local.memory-request", {})}`,
		...routed.todos.map(
			(todo) =>
				`- t${todo.ref}: ${systemContext(todo.open ? "dialogue.contexts.local.todo" : "dialogue.contexts.local.todo-done", { title: lineText(todo.title) })}`,
		),
		...(input.retry
			? [
					INPUT_HEADINGS.retry,
					systemContext("dialogue.contexts.local.retry", {
						reason: lineText(input.retry),
					}),
				]
			: []),
		`${INPUT_HEADINGS.user}\n${dataText(input.utterance)}`,
	];
	return [
		{
			role: "system",
			content: systemContext("dialogue.contexts.local.choice", {
				style: input.style,
			}),
		},
		{ role: "user", content: lines.join("\n") },
	];
}

/** The pending turn's input: the open confirmations and questions, the agent's last words, and the user's words. */
export function pendingMessages(
	routed: RoutedInput,
	utterance: string,
): ChatMessage[] {
	const lines = [
		INPUT_HEADINGS.pending,
		...routed.pending.confirmations.map(
			(c) =>
				`- c${c.ref} 確認待ち: ${lineText(c.toolchain)}「${lineText(c.request)}」${c.target ? ` 対象「${lineText(c.target)}」` : ""}`,
		),
		...routed.pending.questions.map(
			(q) =>
				`- t${q.ref} 質問「${lineText(q.title)}」: ${lineText(q.question)}`,
		),
		...previousLine(routed),
		`${INPUT_HEADINGS.user}\n${dataText(utterance)}`,
	];
	return [
		{
			role: "system",
			content: systemContext("dialogue.contexts.local.pending", {}),
		},
		{ role: "user", content: lines.join("\n") },
	];
}

/**
 * A choice call's answer: the object it returned, or null when it is not one with a `choice`. A cloud provider's strict
 * form (`strictChoiceSchema`) fills every field: the ones it left null are dropped, and inputs written as a JSON text
 * are read back into their object.
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
	return chosen as Record<string, unknown> & { choice: string };
}

/** A field in the strict form: no length ranges; an object the provider can not hold strictly as its JSON text. */
function strictField(field: Schema): Schema {
	if (Array.isArray(field.anyOf))
		return { anyOf: (field.anyOf as Schema[]).map(strictField) };
	if (field.type === "object")
		return {
			type: "string",
			description: "選んだ担当の欄を、JSON の object の文字列で",
		};
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
 * choice does not use it, no additional properties and no length ranges. LARM keeps the branches; on the cloud the
 * host's own checks hold what the branches held (a field of another branch is refused there).
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
