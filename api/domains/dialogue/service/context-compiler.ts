import type { Tx } from "../../queue";
import type { ConversationService } from "../../conversation";
import { TURN_WINDOW, type WindowSnapshot } from "../../memory";
import type { Run } from "../contracts";
import { recentPriorRuns } from "../repository";
import type { ChatMessage } from "./context";
import { buildSystemPrompt } from "./system-prompt";

// The size of the verbatim window is shared with memory (its prefetch looks only before it).
export { TURN_WINDOW };
/** The verbatim exchanges stay inside this size, whatever their length. */
export const HISTORY_MAX_BYTES = 48 * 1024;
/** The newest exchanges that are never dropped for size. */
const KEEP_RUNS = 2;

const bytesOf = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * The model-visible context of a run, in the fixed order
 * `[L0 system, L1 long-term?, L2 short-term?, ...L3 recent exchanges, L5 this input]`.
 * L4 (notices, prefetched earlier exchanges, World, operation results) is placed by the caller
 * right before L5; `tail` is the part of it that is decided here.
 */
export function compileContext(
	tx: Tx,
	run: Run,
	conversation: ConversationService,
	general: Parameters<typeof buildSystemPrompt>[0] | undefined,
	window: WindowSnapshot | null,
): {
	messages: ChatMessage[];
	/** The L1/L2 bodies at `messages[1..]` (the research context keeps them in place). */
	references: string[];
	tail: ChatMessage[];
	/**
	 * The ordinal of the oldest message actually sent as L3 (the current input's when none is): the recall of
	 * earlier exchanges looks only before it.
	 */
	windowStartOrdinal: number;
	/** The prefetch overlaps the sent exchanges and is left out of this turn (its pins must not be checked either). */
	prefetchDropped: boolean;
} {
	const messages: ChatMessage[] = [
		{
			role: "system",
			content: buildSystemPrompt(
				general ?? { agentName: "", userName: "", persona: "butler" },
			),
		},
	];
	// Memory and World are reference data, never an instruction: each layer gets its own labelled message.
	const references = [
		window?.longTerm.text ?? "",
		window?.shortTerm.text ?? "",
	].filter((text) => text !== "");
	for (const content of references) messages.push({ role: "system", content });

	const exchanges = recentPriorRuns(tx, run, TURN_WINDOW).map((prior) => {
		const pair: ChatMessage[] = [];
		const ordinals: number[] = [];
		const input = conversation.messageInTransaction(tx, prior.inputMessageId);
		if (input) {
			pair.push({
				role: "user",
				content: input.message.text,
				...(input.message.attachments?.length
					? {
							attachments: input.message.attachments,
							sourceMessageId: input.message.id,
						}
					: {}),
			});
			ordinals.push(input.ordinal);
		}
		if (prior.status === "completed" && prior.answerMessageId) {
			const answer = conversation.messageInTransaction(
				tx,
				prior.answerMessageId,
			);
			if (answer) {
				pair.push({ role: "assistant", content: answer.message.text });
				ordinals.push(answer.ordinal);
			}
		}
		return Object.assign(pair, { ordinals });
	});
	// Whole exchanges only: drop the oldest until the rest fits, keeping the newest few.
	const size = (pair: ChatMessage[]) =>
		pair.reduce((sum, message) => sum + bytesOf(message.content), 0);
	let total = exchanges.reduce((sum, pair) => sum + size(pair), 0);
	let first = 0;
	while (total > HISTORY_MAX_BYTES && exchanges.length - first > KEEP_RUNS)
		total -= size(exchanges[first++]!);
	for (const pair of exchanges.slice(first)) messages.push(...pair);

	const input = conversation.messageInTransaction(tx, run.inputMessageId);
	if (input)
		messages.push({
			role: "user",
			content: input.message.text,
			...(input.message.attachments?.length
				? {
						attachments: input.message.attachments,
						sourceMessageId: input.message.id,
					}
				: {}),
		});
	const sent = [
		...exchanges.slice(first).flatMap((pair) => pair.ordinals),
		...(input ? [input.ordinal] : []),
	];
	const windowStartOrdinal = sent.length > 0 ? Math.min(...sent) : 0;
	// A prefetch that stands on messages already sent verbatim would repeat them.
	const prefetchDropped = !!window?.prefetch.pins.some(
		(pin) =>
			(conversation.messageInTransaction(tx, pin.messageId)?.ordinal ?? 0) >=
			windowStartOrdinal,
	);

	const tail: ChatMessage[] = [];
	const notice = window ? noticeMessage(window) : null;
	if (notice) tail.push(notice);
	if (window && window.prefetch.text !== "" && !prefetchDropped)
		tail.push({ role: "system", content: window.prefetch.text });
	return { messages, references, tail, windowStartOrdinal, prefetchDropped };
}

/** The one-time notices of the memory step as a system message, or null when there are none. */
export function noticeMessage(window: WindowSnapshot): ChatMessage | null {
	if (window.notices.length === 0) return null;
	return {
		role: "system",
		content: `記憶の担当からの連絡です。必要なら会話の中で一言伝えてください。\n${window.notices
			.map((notice) => `- ${notice.text}`)
			.join("\n")}`,
	};
}

/** True when the window contributes nothing to the prompt (no layer text, no notice). */
export function windowIsEmpty(window: WindowSnapshot): boolean {
	return (
		window.longTerm.text === "" &&
		window.shortTerm.text === "" &&
		window.prefetch.text === "" &&
		window.notices.length === 0
	);
}
