/**
 * A scripted model for the conversation's fixed tools (the ContextWindow specification, sections 6.1 to 6.7).
 *
 * A user's utterance is one generation: the model calls `find_toolchain` to search, `delegate` to hand the work over,
 * and `respond` with the analysis that makes its speech legal. Each model call of that generation is one step: the
 * step index is the number of tool-call exchanges already carried out after the utterance, so a script reads the
 * results of the earlier steps from the messages, exactly as the real model would.
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

/** One model call: speech and/or tool calls. Speech beside a tool call is a preamble the host withdraws. */
export type Step = { text?: string; calls?: Call[] };

/** The analysis of a request answered from hand (a plain answer that needs no basis). */
export const CHAT = {
	kind: "chat",
	freshness: "not_live",
	impact: "none",
	approved: false,
} as const;

/** The utterance's analysis. Extra fields (todoRefs, about, unavailable) go in `args`. */
export const respond = (args: Record<string, unknown> = {}): Call => ({
	name: "respond",
	args: { ...CHAT, ...args },
});

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

/** The step's speech with a single tool call (the speech is a preamble unless the call is `respond`). */
export const answerWith = (text: string, call: Call): Step => ({
	text,
	calls: [call],
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
			: { calls: [respond({ unavailable: true })] };
	};

/** What the conversation says when no toolchain can do the request (the `unavailable` analysis). */
export const UNAVAILABLE_TEXT = "その依頼は、今の担当ではできません。";

/**
 * The step after a delegation returned its result in this generation: an instant answer is the speech (the basis is
 * the answer itself), and an answer the toolchain could not give is said as unavailable (no automatic fallback).
 * Undefined before a result.
 */
export function handedStep(messages: ConversationMessage[]): Step | undefined {
	const handed = toolResults(afterUtterance(messages), "delegate")[0] as
		| { answered?: boolean; answer?: string }
		| undefined;
	// A refused call (the host closes a call that was rejected with `{refused: true}`) is no result to answer from.
	if (!handed || !("answered" in handed)) return undefined;
	return handed.answered && handed.answer
		? {
				text: handed.answer,
				calls: [respond({ kind: "live_info", freshness: "live" })],
			}
		: { text: UNAVAILABLE_TEXT, calls: [respond({ unavailable: true })] };
}

/** The messages after the utterance: the generation's own exchanges (tool calls and their results). */
export function afterUtterance(
	messages: ConversationMessage[],
): ConversationMessage[] {
	const last = messages.map((m) => m.role).lastIndexOf("user");
	return last < 0 ? [] : messages.slice(last + 1);
}

/** Whether the request offers the fixed tools (a user's utterance is then analysed by `respond`). */
export function isUtteranceRound(
	tools: ReadonlyArray<{ function: { name: string } }> | undefined,
): boolean {
	return !!tools?.some((tool) => tool.function.name === "respond");
}

/** Whether the generation is the result phase: the host's fixed text reports a finished TODO. */
export function isResultRound(messages: ConversationMessage[]): boolean {
	const last = messages.filter((m) => m.role === "user").at(-1);
	return !!last?.content.startsWith("新しい出来事があります");
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

/** The shape of a LARM receipt's `executeStream` the wrapper below reads. */
type Stream = (
	requestId: string,
	messages: unknown,
	signal: AbortSignal,
	onDelta: (text: string) => void,
	preparation: unknown,
	tools: ReadonlyArray<{ function: { name: string } }> | undefined,
	session: unknown,
) => Promise<{ toolCalls?: unknown[] } & Record<string, unknown>>;

/**
 * A model whose answer ends with `respond` when it makes no tool call at all: a user's utterance must be analysed by
 * `respond` (the conversation's fixed tools), and a fake that only writes text has no tool to call. Both the receipt
 * path (`executeStream`) and the plain path (`answer`, with the tool callbacks) are covered. Every other call goes
 * through the wrapped model unchanged.
 */
export function withRespond<
	T extends {
		executeStream?: unknown;
		answer?: unknown;
		answerStream?: unknown;
	},
>(model: T): T {
	const respondCall = () => ({
		id: "respond",
		name: "respond",
		arguments: JSON.stringify({ ...CHAT }),
	});
	type Options = {
		tools?: ReadonlyArray<{ function: { name: string } }>;
		onToolCalls?: (calls: unknown[]) => void;
	};
	/** The call options with a tool callback that records whether the model made a call. */
	const watched = (options: Options | undefined) => {
		const state = { called: false };
		if (!options?.tools?.some((tool) => tool.function.name === "respond"))
			return { options, state, tracked: false };
		return {
			options: {
				...options,
				onToolCalls: (calls: unknown[]) => {
					state.called = true;
					options.onToolCalls?.(calls);
				},
			},
			state,
			tracked: true,
		};
	};
	const stream = model.executeStream as Stream | undefined;
	const answer = model.answer as
		| ((
				messages: unknown,
				signal: AbortSignal,
				options?: Options,
		  ) => Promise<string>)
		| undefined;
	const answerStream = model.answerStream as
		| ((
				messages: unknown,
				signal: AbortSignal,
				delta: (text: string) => void,
				options?: Options,
		  ) => Promise<string>)
		| undefined;
	const wrapped: Record<string, unknown> = {};
	if (stream)
		wrapped.executeStream = async (...args: Parameters<Stream>) => {
			const receipt = await stream(...args);
			const offered = args[5]?.some((tool) => tool.function.name === "respond");
			return offered && !receipt.toolCalls?.length
				? { ...receipt, toolCalls: [respondCall()] }
				: receipt;
		};
	if (answer)
		wrapped.answer = async (
			messages: unknown,
			signal: AbortSignal,
			options?: Options,
		) => {
			const watch = watched(options);
			const text = await answer(messages, signal, watch.options);
			if (watch.tracked && !watch.state.called)
				options?.onToolCalls?.([respondCall()]);
			return text;
		};
	if (answerStream)
		wrapped.answerStream = async (
			messages: unknown,
			signal: AbortSignal,
			delta: (text: string) => void,
			options?: Options,
		) => {
			const watch = watched(options);
			const text = await answerStream(messages, signal, delta, watch.options);
			if (watch.tracked && !watch.state.called)
				options?.onToolCalls?.([respondCall()]);
			return text;
		};
	return { ...model, ...wrapped } as T;
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
