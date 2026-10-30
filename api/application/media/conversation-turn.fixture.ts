import {
	callsOf,
	candidatesOf,
	choiceByScript,
	choiceRound,
	delegate,
	findToolchain,
	isNoticeRound,
	isUtteranceRound,
	utteranceOf,
	UNAVAILABLE_TEXT,
	type ConversationMessage,
	type Step,
} from "../toolchain/conversation-script.fixture";

/**
 * The model's usual path for a media utterance (sections 6.1 and 6.5): search for the toolchain by its id, then hand
 * the request over with the announcement. The hand-over ends the generation.
 */
export function handOver(
	toolchain: string,
	announcement: string,
	impact: "none" | "create" | "modify_existing" | "irreversible" = "create",
	/** The search text the model writes for find_toolchain (the utterance by default). */
	query: (messages: ConversationMessage[]) => string = utteranceOf,
) {
	return (messages: ConversationMessage[]): Step => {
		const candidates = candidatesOf(messages);
		if (!candidates) return { calls: [findToolchain(query(messages))] };
		const chosen = candidates.find((candidate) => candidate.id === toolchain);
		return chosen
			? {
					calls: [
						delegate(chosen.id, utteranceOf(messages), {
							announcement,
							impact,
						}),
					],
				}
			: { text: UNAVAILABLE_TEXT };
	};
}

/**
 * Answers one model call when it is the user's utterance's generation: the conversation's fixed tools are offered
 * (the agent loop), or it is the local harness's silent choice, made from the same step. Returns undefined for every
 * other call, which the caller answers itself (the routed turn's talk call among them).
 */
export function answerUtterance(
	options:
		| (NonNullable<Parameters<typeof isUtteranceRound>[0]> & {
				jsonSchema?: unknown;
		  })
		| undefined,
	messages: ConversationMessage[],
	onToolCalls: ((calls: ReturnType<typeof callsOf>) => void) | undefined,
	step: (messages: ConversationMessage[]) => Step,
	onHandOver?: () => void,
): string | Promise<string> | undefined {
	const round = options?.jsonSchema ? choiceRound(messages) : null;
	if (round)
		return choiceByScript(messages, round, (loop) => {
			const chosen = step(loop);
			if (chosen.calls?.some((call) => call.name === "delegate"))
				onHandOver?.();
			return chosen;
		});
	if (!isUtteranceRound(options) || isNoticeRound(messages)) return undefined;
	const chosen = step(messages);
	if (chosen.calls?.length) {
		if (chosen.calls.some((call) => call.name === "delegate")) onHandOver?.();
		onToolCalls?.(callsOf(chosen, () => crypto.randomUUID()));
	}
	return chosen.text ?? "";
}
