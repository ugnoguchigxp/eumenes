/**
 * A scripted model for the conversation agent's fixed tools (the ContextWindow specification, sections 6.1 to 6.7).
 *
 * A user's utterance is one generation: the model answers in plain text, and calls `find_toolchain` to search and
 * `delegate` to hand the work over when the conversation calls for it. Each model call of that generation is one
 * step: the step index is the number of tool-call exchanges already carried out after the utterance, so a script
 * reads the results of the earlier steps from the messages, exactly as the real model would.
 */

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

/** One candidate of a `find_toolchain` result (the ids the delegation names). */
export type Candidate = {
	id: string;
	title: string;
	summary: string;
	useWhen: string[];
	execution?: string;
	inputs?: unknown;
};

/** The candidates of the generation's search, if the model has searched (its result is the candidate list). */
export function candidatesOf(
	messages: ConversationMessage[],
): Candidate[] | undefined {
	const search = toolResults(afterUtterance(messages), "find_toolchain")[0] as
		| { candidates?: Candidate[] }
		| undefined;
	return search?.candidates;
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
	const handed = toolResults(afterUtterance(messages), "delegate")[0] as
		| { answered?: boolean; answer?: string }
		| undefined;
	// A refused call (the host closes a call that was rejected with `{refused: true}`) is no result to answer from.
	if (!handed || !("answered" in handed)) return undefined;
	return {
		text: handed.answered && handed.answer ? handed.answer : UNAVAILABLE_TEXT,
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

/** Whether the generation has no new utterance: the host's fixed trigger text is its newest message (a host notice). */
export function isNoticeRound(messages: ConversationMessage[]): boolean {
	const last = messages.filter((m) => m.role === "user").at(-1);
	return !!last?.content.startsWith("新しい出来事があります");
}

/**
 * The material document of a generation (ContextWindow spec, section 4): its first user message, the four tagged
 * sections `<memory>`, `<history>`, `<log>` and `<state>`. Empty when the generation has none.
 */
export function documentOf(messages: ConversationMessage[]): string {
	return (
		messages.find((m) => m.role === "user" && m.content.startsWith("<memory>"))
			?.content ?? ""
	);
}

/**
 * The ids of the toolchains the document's `<state>` retains (section 4.4): its `担当 <id> <summary>` lines. The
 * `<log>` section's own `担当` lines are not retained toolchains, so only the `<state>` section is read.
 */
export function retainedIds(messages: ConversationMessage[]): string[] {
	const document = documentOf(messages);
	const start = document.indexOf("<state>");
	if (start < 0) return [];
	return [...document.slice(start).matchAll(/^担当 (\S+) /gm)].map(
		(match) => match[1]!,
	);
}

/** The tool results of one tool name in the generation, parsed, oldest first. */
export function toolResults(
	messages: ConversationMessage[],
	name: string,
): unknown[] {
	const names = new Map<string, string>();
	for (const message of messages)
		for (const call of message.tool_calls ?? [])
			names.set(call.id, call.function.name);
	return messages
		.filter(
			(m) => m.role === "tool" && names.get(m.tool_call_id ?? "") === name,
		)
		.map((m) => JSON.parse(m.content) as unknown);
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
