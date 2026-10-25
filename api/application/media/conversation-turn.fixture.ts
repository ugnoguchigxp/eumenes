import {
	callsOf,
	candidatesOf,
	delegate,
	findToolchain,
	isNoticeRound,
	isUtteranceRound,
	retainedIds,
	UNAVAILABLE_TEXT,
	type ConversationMessage,
	type Step,
} from "../toolchain/conversation-script.fixture";

export { retainedIds };

/** The text of the newest user message: the utterance a generation answers. */
export function lastUtterance(messages: ConversationMessage[]): string {
	return messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
}

/**
 * The model's usual path for a media utterance (sections 6.1 and 6.5): search for the toolchain by its id, then hand
 * the request over with the announcement. The hand-over ends the generation.
 */
export function handOver(
	toolchain: string,
	announcement: string,
	impact: "none" | "create" | "modify_existing" | "irreversible" = "create",
	/** The search text the model writes for find_toolchain (the utterance by default). */
	query: (messages: ConversationMessage[]) => string = lastUtterance,
) {
	return (messages: ConversationMessage[]): Step => {
		// A toolchain the conversation retained (a `担当` line of the document's <state>, spec section 4.4) is delegated to without a search.
		if (retainedIds(messages).includes(toolchain))
			return {
				calls: [
					delegate(toolchain, lastUtterance(messages), {
						announcement,
						impact,
					}),
				],
			};
		const candidates = candidatesOf(messages);
		if (!candidates) return { calls: [findToolchain(query(messages))] };
		const chosen = candidates.find((candidate) => candidate.id === toolchain);
		return chosen
			? {
					calls: [
						delegate(chosen.id, lastUtterance(messages), {
							announcement,
							impact,
						}),
					],
				}
			: { text: UNAVAILABLE_TEXT };
	};
}

/**
 * Answers one model call when it is the user's utterance's generation (the conversation's fixed tools are offered). Returns undefined for every other call, which the caller answers itself.
 */
export function answerUtterance(
	options: Parameters<typeof isUtteranceRound>[0],
	messages: ConversationMessage[],
	onToolCalls: ((calls: ReturnType<typeof callsOf>) => void) | undefined,
	step: (messages: ConversationMessage[]) => Step,
	onHandOver?: () => void,
): string | undefined {
	if (!isUtteranceRound(options) || isNoticeRound(messages)) return undefined;
	const chosen = step(messages);
	if (chosen.calls?.length) {
		if (chosen.calls.some((call) => call.name === "delegate")) onHandOver?.();
		onToolCalls?.(callsOf(chosen, () => crypto.randomUUID()));
	}
	return chosen.text ?? "";
}
