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
 * and the resources it works on from those `## State` names.
 */
function candidateBranch(
	candidate: ChoiceCandidate,
	resources: readonly string[],
): Schema {
	const choice = only(candidate.id);
	if (candidate.execution === "instant")
		return branch({ choice, inputs: candidate.inputs ?? ANY_OBJECT });
	if (candidate.execution === "pipeline")
		return branch({ choice, say: SAY, inputs: candidate.inputs ?? ANY_OBJECT });
	return branch(
		{
			choice,
			say: SAY,
			request: text(REQUEST_CHARS),
			...(candidate.targets?.length
				? { target: oneOf(candidate.targets.map((target) => target.ref)) }
				: {}),
			...(resources.length
				? { refs: { type: "array", maxItems: 8, items: oneOf(resources) } }
				: {}),
		},
		["target", "refs"],
	);
}

/**
 * The request turn's schema: none, a question back, one branch per candidate (but those `excluded`), the memory
 * operations, and a correction or cancellation of each open TODO.
 */
export function choiceSchema(
	candidates: readonly ChoiceCandidate[],
	{ todos, resources }: Pick<RoutedInput, "todos" | "resources">,
	excluded: ReadonlySet<string> = new Set(),
): Schema {
	return {
		anyOf: [
			branch({ choice: only("none") }),
			branch({ choice: only("ask"), say: SAY }),
			...candidates
				.filter((candidate) => !excluded.has(candidate.id))
				.map((candidate) => candidateBranch(candidate, resources)),
			branch({ choice: only("memory.recall"), query: text(500) }),
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
		`- memory.recall: ${systemContext("dialogue.contexts.local.memory-recall", {})}`,
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

/** A choice call's answer: the object it returned, or null when it is not one with a `choice`. */
export function parseChoice(
	value: unknown,
): (Record<string, unknown> & { choice: string }) | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(value ?? ""));
	} catch {
		return null;
	}
	return parsed &&
		typeof parsed === "object" &&
		!Array.isArray(parsed) &&
		typeof (parsed as { choice?: unknown }).choice === "string"
		? (parsed as Record<string, unknown> & { choice: string })
		: null;
}
