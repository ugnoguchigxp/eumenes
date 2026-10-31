/**
 * A scripted model for the conversation agent's fixed tools (the conversation input specification, sections 3 and 9).
 *
 * A user's utterance is one generation: the model answers in plain text, and calls `find_toolchain` to search and
 * `delegate` to hand the work over when the conversation calls for it. Each model call of that generation is one
 * step: the step index is the number of tool-call exchanges already carried out after the utterance, so a script
 * reads the results of the earlier steps from the messages, exactly as the real model would.
 */

import { isReadToolName } from "../../domains/capabilities";
import { INPUT_HEADINGS } from "../../domains/dialogue";

/** A message as the generation loop keeps it: assistant tool calls and their tool results. */
export type ConversationMessage = {
	role: string;
	content: string;
	tool_calls?: Array<{
		id: string;
		function: { name: string; arguments: string };
	}>;
	tool_call_id?: string;
};

/** One tool call the model makes. */
export type Call = { name: string; args: Record<string, unknown> };

/** One model call: speech and/or tool calls. Speech beside a tool call is a preamble the agent keeps. */
export type Step = { text?: string; calls?: Call[] };

/** The search for a toolchain that fits the request. */
export const findToolchain = (query: string): Call => ({
	name: "find_toolchain",
	args: { query },
});

/**
 * A delegation that runs now. Without `inputs` it is a TODO: the announcement (required) is saved and the run is
 * handed over. With `inputs` it is an instant answer, which carries no announcement.
 */
export const delegate = (
	toolchain: string,
	request: string,
	args: Record<string, unknown> = {},
): Call => ({
	name: "delegate",
	args: { mode: "execute", toolchain, request, impact: "none", ...args },
});

/** An instant toolchain: no announcement and no TODO; its answer comes back as the tool result. */
export const instantExecute = (
	toolchain: string,
	request: string,
	inputs: Record<string, unknown>,
): Call => delegate(toolchain, request, { inputs });

/** A change that needs the user's approval first: the confirmation is shown, nothing runs. */
export const confirm = (
	toolchain: string,
	request: string,
	args: Record<string, unknown> = {},
): Call => ({
	name: "delegate",
	args: {
		mode: "confirm",
		toolchain,
		request,
		impact: "modify_existing",
		...args,
	},
});

/** The approval of a confirmation the earlier utterance made (its id is in state.pendingConfirmation). */
export const approve = (
	confirmation: string,
	announcement = "差し替えます。",
): Call => ({
	name: "delegate",
	args: { mode: "approve", confirmation, announcement },
});

/**
 * One candidate of a `find_toolchain` result (the ids the delegation names). The result is text (section 9): a
 * candidate is one `- <id>: <description>` line, and `text` is the description with its `execution: <kind>` and
 * `inputs: <parameters>` parts as the host wrote them.
 */
export type Candidate = {
	id: string;
	text: string;
	execution?: string;
};

/** The result's own fields, which are lines of the same form but no candidates. */
const SEARCH_FIELDS = new Set(["discovery", "code"]);

/** The candidates of the generation's search, if the model has searched (its result is the candidate list). */
export function candidatesOf(
	messages: ConversationMessage[],
): Candidate[] | undefined {
	const search = toolResults(afterUtterance(messages), "find_toolchain")[0];
	if (search === undefined) return undefined;
	return search.split("\n").flatMap((line) => {
		const match = /^- (\S+): (.*)$/.exec(line);
		if (!match || SEARCH_FIELDS.has(match[1]!)) return [];
		const execution = /execution: (\S+?)(?:。|$)/.exec(match[2]!)?.[1];
		return [
			{
				id: match[1]!,
				text: match[2]!,
				...(execution ? { execution } : {}),
			},
		];
	});
}

/** The value of a `- <key>: <value>` line of a tool result (section 9); undefined when it has none. */
export function resultField(result: string, key: string): string | undefined {
	return new RegExp(`^- ${key}: (.*)$`, "m").exec(result)?.[1];
}

/**
 * The model's usual path for a request: search first, then hand the work to the candidate `pick` chooses. Stateless
 * over the messages, so it answers any step of the generation the way the model would at that point.
 */
export const searchThenDelegate =
	(
		pick: (candidate: Candidate) => boolean,
		request: string,
		args: Record<string, unknown> = {},
	) =>
	(messages: ConversationMessage[]): Step => {
		const handed = handedStep(messages);
		if (handed) return handed;
		const candidates = candidatesOf(messages);
		if (!candidates) return { calls: [findToolchain(request)] };
		const chosen = candidates.find(pick);
		return chosen
			? { calls: [delegate(chosen.id, request, args)] }
			: { text: UNAVAILABLE_TEXT };
	};

/** What the conversation says when no toolchain can do the request. */
export const UNAVAILABLE_TEXT = "その依頼は、今の担当ではできません。";

/**
 * The step after a delegation returned its result in this generation: an instant answer is the speech, and an answer the toolchain could not give is said as unavailable (no automatic fallback).
 * Undefined before a result.
 */
export function handedStep(messages: ConversationMessage[]): Step | undefined {
	const handed = toolResults(afterUtterance(messages), "delegate")[0];
	// A refused call (the host closes a call that was rejected with `- refused: true`) is no result to answer from.
	if (handed === undefined || resultField(handed, "answered") === undefined)
		return undefined;
	const answer = resultField(handed, "answer");
	return {
		text:
			resultField(handed, "answered") === "true" && answer
				? answer
				: UNAVAILABLE_TEXT,
	};
}

/** The messages after the utterance: the generation's own exchanges (tool calls and their results). */
export function afterUtterance(
	messages: ConversationMessage[],
): ConversationMessage[] {
	const last = messages.map((m) => m.role).lastIndexOf("user");
	return last < 0 ? [] : messages.slice(last + 1);
}

/**
 * Whether the call is a conversation agent's reply: it offers the conversation's fixed tools to be called. A
 * background call on the conversation's prompt sends the same tools only to keep the prefix (`toolChoice: none`).
 */
export function isUtteranceRound(
	options:
		| {
				tools?: ReadonlyArray<{ function: { name: string } }>;
				toolChoice?: string;
		  }
		| undefined,
): boolean {
	return (
		options?.toolChoice !== "none" &&
		!!options?.tools?.some((tool) => tool.function.name === "find_toolchain")
	);
}

/** The newest user message: the generation's last input (its headings are the dialogue domain's `INPUT_HEADINGS`). */
const lastUserMessage = (messages: ConversationMessage[]) =>
	messages.filter((m) => m.role === "user").at(-1)?.content ?? "";

/** The lines of one section of a user message (its heading line to the next heading); undefined when it has none. */
function sectionOf(content: string, heading: string): string | undefined {
	const lines = content.split("\n");
	const start = lines.indexOf(heading);
	if (start < 0) return undefined;
	const length = lines
		.slice(start + 1)
		.findIndex((line) => line.startsWith("## "));
	return lines
		.slice(start + 1, length < 0 ? undefined : start + 1 + length)
		.join("\n");
}

/** Whether the generation has no new utterance: its newest message carries a host notice instead of `## User`. */
export function isNoticeRound(messages: ConversationMessage[]): boolean {
	return (
		sectionOf(lastUserMessage(messages), INPUT_HEADINGS.notice) !== undefined
	);
}

/** The words the generation answers: the body of the newest message's `## User` (empty for a host notice). */
export function utteranceOf(messages: ConversationMessage[]): string {
	return sectionOf(lastUserMessage(messages), INPUT_HEADINGS.user) ?? "";
}

/** The tool results of one tool name in the generation, as the model read them (text), oldest first. */
export function toolResults(
	messages: ConversationMessage[],
	name: string,
): string[] {
	const names = new Map<string, string>();
	for (const message of messages)
		for (const call of message.tool_calls ?? [])
			names.set(call.id, call.function.name);
	return messages
		.filter(
			(m) => m.role === "tool" && names.get(m.tool_call_id ?? "") === name,
		)
		.map((m) => m.content);
}

/** The number of model calls already made in this generation (each made tool calls). */
export function stepIndex(messages: ConversationMessage[]): number {
	return afterUtterance(messages).filter(
		(m) => m.role === "assistant" && m.tool_calls?.length,
	).length;
}

/**
 * A script of steps for one utterance: the step at the generation's index is the model's answer (a step may read
 * the messages). Past the script the result is undefined, so the caller falls back to its default behaviour.
 */
export function scripted(
	steps: Array<Step | ((messages: ConversationMessage[]) => Step)>,
): (messages: ConversationMessage[]) => Step | undefined {
	return (messages) => {
		const step = steps[stepIndex(messages)];
		return typeof step === "function" ? step(messages) : step;
	};
}

/**
 * Which silent choice of the local harness's routed turn a call is (the local harness rebuild plan, sections 4.3 and
 * 4.4): its input has the request turn's candidates or the pending turn's open items; null for any other call.
 */
export function choiceRound(
	messages: ConversationMessage[],
): "request" | "pending" | null {
	const last = lastUserMessage(messages);
	if (sectionOf(last, INPUT_HEADINGS.candidates) !== undefined)
		return "request";
	if (sectionOf(last, INPUT_HEADINGS.pending) !== undefined) return "pending";
	return null;
}

/** What a routed turn's choice says when it makes no choice: none (the talk turn answers). */
const NONE = JSON.stringify({ choice: "none" });
/** The words a script's operation is said with when it carries none of its own. */
const SAY = "承りました。";

/**
 * A routed turn's choice from a script written for the agent loop: the script runs as the loop would, its search
 * answered with this turn's candidates (the host searched already), and its first call that acts becomes the choice.
 * A script that answers in words chooses none; on the pending turn only an approval or an answer to a work is a
 * choice.
 */
export async function choiceByScript(
	messages: ConversationMessage[],
	round: "request" | "pending",
	step: (loop: ConversationMessage[]) => Promise<Step> | Step,
): Promise<string> {
	const candidates =
		sectionOf(lastUserMessage(messages), INPUT_HEADINGS.candidates) ?? "";
	let loop = messages.map((m) => ({ ...m }));
	for (let index = 0; index < 4; index++) {
		const call = (await step(loop)).calls?.[0];
		if (!call) return NONE;
		if (call.name !== "find_toolchain") {
			const choice = choiceOf(call, round);
			return choice ? JSON.stringify(choice) : NONE;
		}
		const id = `script-${index}`;
		loop = [
			...loop,
			{
				role: "assistant",
				content: "",
				tool_calls: [
					{
						id,
						function: { name: call.name, arguments: JSON.stringify(call.args) },
					},
				],
			},
			{ role: "tool", tool_call_id: id, content: candidates },
		];
	}
	return NONE;
}

/**
 * The routed turn's choice when this call is one (it carries a schema and the choice's sections), made from the
 * step a loop script takes; undefined for any other call.
 */
export function routedChoice<M>(
	options: { jsonSchema?: unknown } | undefined,
	messages: readonly M[],
	step: (loop: M[]) => Promise<Step> | Step,
): Promise<string> | undefined {
	// The loop messages a script reads are the conversation's own shape, whatever type the caller holds them as.
	const conversation = messages as unknown as ConversationMessage[];
	const round = options?.jsonSchema ? choiceRound(conversation) : null;
	return round
		? choiceByScript(conversation, round, (loop) =>
				step(loop as unknown as M[]),
			)
		: undefined;
}

/** A loop call as the routed turn's choice; null when the round has no such choice. */
function choiceOf(
	call: Call,
	round: "request" | "pending",
): Record<string, unknown> | null {
	const a = call.args;
	if (call.name === "work")
		return a.operation === "answer"
			? { choice: "answer", todo: a.todo, text: a.text }
			: round === "request"
				? {
						choice: a.todo,
						operation: a.operation,
						...(a.text ? { text: a.text } : {}),
						say: SAY,
					}
				: null;
	if (call.name === "delegate" && a.mode === "approve")
		return { choice: "approve", confirmation: a.confirmation };
	if (round === "pending") return null;
	if (call.name === "memory")
		return {
			choice: "memory.request",
			kind: a.kind,
			what: a.what,
			...(a.detail ? { detail: a.detail } : {}),
			say: SAY,
		};
	// A read tool the search offered is chosen with its arguments as the inputs.
	if (isReadToolName(call.name)) return { choice: call.name, inputs: a };
	if (call.name !== "delegate") return null;
	return {
		choice: a.toolchain,
		...(a.inputs !== undefined ? { inputs: a.inputs } : {}),
		...(typeof a.request === "string" ? { request: a.request } : {}),
		say: typeof a.announcement === "string" ? a.announcement : SAY,
		...(a.target ? { target: a.target } : {}),
		...(a.refs ? { refs: a.refs } : {}),
	};
}

/**
 * The context window a fake LARM connection reports for the conversation's generations. The generation's fixed part
 * (the system prompt and the fixed tool definitions) must fit it, so a fixture that reports the small reference
 * window would refuse every utterance (`window_too_small`).
 */
export const CONVERSATION_WINDOW_TOKENS = 262144;

/** The ids of the calls the step makes, as the model's tool calls (the receipt's shape). */
export function callsOf(step: Step, id: () => string) {
	return (step.calls ?? []).map((call) => ({
		id: id(),
		name: call.name,
		arguments: JSON.stringify(call.args),
	}));
}
