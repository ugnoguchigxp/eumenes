import {
	callsOf,
	candidatesOf,
	delegate,
	findToolchain,
	isNoticeRound,
	isUtteranceRound,
	UNAVAILABLE_TEXT,
	type ConversationMessage,
	type Step,
} from "../toolchain/conversation-script.fixture";

type Tools = ReadonlyArray<{ function: { name: string } }> | undefined;

/** The generation's JSON document (the message that starts with the profile section), parsed; {} when absent. */
function documentOf(messages: ConversationMessage[]): Record<string, any> {
	const document = messages.find((m) => m.content.startsWith('{"profile":'));
	return document ? JSON.parse(document.content) : {};
}

/** The ids of the toolchains the document's `state.retained` lists. */
export function retainedIds(messages: ConversationMessage[]): string[] {
	return (
		(documentOf(messages).state?.retained ?? []) as Array<{ id: string }>
	).map((item) => item.id);
}

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
		// A toolchain the conversation retained (state.retained, section 6.2) is delegated to without a search.
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
	tools: Tools,
	messages: ConversationMessage[],
	onToolCalls: ((calls: ReturnType<typeof callsOf>) => void) | undefined,
	step: (messages: ConversationMessage[]) => Step,
	onHandOver?: () => void,
): string | undefined {
	if (!isUtteranceRound(tools) || isNoticeRound(messages)) return undefined;
	const chosen = step(messages);
	if (chosen.calls?.length) {
		if (chosen.calls.some((call) => call.name === "delegate")) onHandOver?.();
		onToolCalls?.(callsOf(chosen, () => crypto.randomUUID()));
	}
	return chosen.text ?? "";
}
