import { MEMORY_HISTORY_MAX_TOKENS, type ContextBlock } from "../../inference";
import { getLogger } from "../../../infrastructure/logger";
import type { Tx } from "../../queue";
import type { ConversationService } from "../../conversation";
import type { MemoryService, WindowSnapshot } from "../../memory";
import type { Run } from "../contracts";
import { recentPriorRuns } from "../repository";
import type { ChatMessage } from "./context";
import { withAttachmentNotes } from "./attachment-context";
import {
	CONVERSATION_HOST_RULES,
	type ContextAssembly,
	type HistoryTurn,
	type PersonaSpec,
} from "./context-assembly";
import {
	longTermBlock,
	noticeBlock,
	prefetchBlock,
	shortTermBlock,
	summaryBlock,
} from "./context-blocks";
import { blockTokens, turnTokens } from "./context-fit";

const log = getLogger("dialogue");
/** The newest exchanges that are never dropped for size. */
const LATEST_EXCHANGES = 2;
/** Earlier runs read at a time while the history is filled from the newest. */
const PRIOR_PAGE = 24;

type HistoryEntry = {
	layer: "keep" | "unprocessed";
	/** The place in the ledger's list (kept ones keep the window's order); -1 for a run the ledger does not list. */
	index: number;
	ordinal: number;
	turns: HistoryTurn[];
	tokens: number;
	pinned: boolean;
};
type MemoryHistory = Pick<
	MemoryService,
	| "verbatimHistoryInTransaction"
	| "blockedMessageIdsOfConversationInTransaction"
>;

export type CompiledAssembly = {
	/** Everything the compile step decides; `volatile` holds the notice and the prefetch (the tail). */
	assembly: ContextAssembly;
	/** Every message the prompt shows verbatim, this input included: a recall must not repeat them. */
	shownMessageIds: string[];
	/** The prefetch overlaps the shown messages and is left out of this turn (its pins must not be checked either). */
	prefetchDropped: boolean;
};

/**
 * The content of a run's context that memory, the ledger and the conversation decide, before any format:
 * the persona, long-term memory and the goals, the verbatim history, the summary and the short-term notes,
 * the input, and the notices and prefetch of this turn. The caller adds the rest of the volatile part.
 *
 * The history (kept, unprocessed, the newest two exchanges) takes what is left of the memory and history budget
 * (`memoryHistoryTokens`) after the long-term memory, the goals, the summary, the short-term notes and the
 * notices and prefetch: the oldest exchanges go first, whole, and the newest two never do. No message is cut
 * and no count of exchanges limits it. Blocked messages are never shown. Without a window (memory off) the
 * runs of the conversation are the history, newest first as far as the budget allows.
 */
export function compileAssembly(
	tx: Tx,
	run: Run,
	conversation: ConversationService,
	general: PersonaSpec | undefined,
	window: WindowSnapshot | null,
	memory?: MemoryHistory,
	goals?: ContextBlock | null,
	/** Leave the specialist sessions' runs out of the fallback history. */
	withoutSpecialist = false,
	/** The whole memory and history budget (tokens) of the model window. */
	memoryHistoryTokens = MEMORY_HISTORY_MAX_TOKENS,
): CompiledAssembly {
	const present = (blocks: Array<ContextBlock | null | undefined>) =>
		blocks.filter((block): block is ContextBlock => !!block);
	const stable = present([window && longTermBlock(window), goals]);
	const working = present([
		window && summaryBlock(window),
		window && shortTermBlock(window),
	]);
	const notices = present([window && noticeBlock(window)]);
	// The prefetch is counted in full here: whether it overlaps the history is known only once the history is.
	const prefetch = present([window && prefetchBlock(window)]);
	const room = Math.max(
		0,
		memoryHistoryTokens -
			[...stable, ...working, ...notices, ...prefetch].reduce(
				(sum, block) => sum + blockTokens(block),
				0,
			),
	);

	const verbatim =
		window && memory
			? memory.verbatimHistoryInTransaction(tx, run.conversationId, window)
			: null;
	const blocked =
		verbatim?.blocked ??
		new Set(
			memory?.blockedMessageIdsOfConversationInTransaction(
				tx,
				run.conversationId,
			) ?? [],
		);
	const refs = new Map(
		[
			...(verbatim?.keep ?? []).map((ref) => ({
				...ref,
				layer: "keep" as const,
			})),
			...(verbatim?.unprocessed ?? []).map((ref) => ({
				...ref,
				layer: "unprocessed" as const,
			})),
		].map((ref, index) => [ref.inputMessageId, { ...ref, index }]),
	);

	const entryOf = (
		ref: {
			inputMessageId: string;
			answerMessageId: string | null;
			layer: "keep" | "unprocessed";
		},
		index: number,
	): HistoryEntry | null => {
		const turns: HistoryTurn[] = [];
		let ordinal: number | null = null;
		if (!blocked.has(ref.inputMessageId)) {
			const input = conversation.messageInTransaction(tx, ref.inputMessageId);
			if (input) {
				turns.push({
					role: "user",
					content: withAttachmentNotes(
						input.message.text,
						input.message.attachments,
					),
					...(input.message.attachments?.length
						? {
								attachments: input.message.attachments,
								sourceMessageId: input.message.id,
							}
						: {}),
					messageId: input.message.id,
					layer: ref.layer,
					at: input.message.createdAt,
				});
				ordinal = input.ordinal;
			}
		}
		if (ref.answerMessageId !== null && !blocked.has(ref.answerMessageId)) {
			const answer = conversation.messageInTransaction(tx, ref.answerMessageId);
			if (answer) {
				turns.push({
					role: "assistant",
					content: answer.message.text,
					messageId: answer.message.id,
					layer: ref.layer,
					at: answer.message.createdAt,
				});
				ordinal ??= answer.ordinal;
			}
		}
		if (turns.length === 0 || ordinal === null) return null;
		return {
			layer: ref.layer,
			index,
			ordinal,
			turns,
			tokens: turns.reduce((sum, turn) => sum + turnTokens(turn.content), 0),
			pinned: false,
		};
	};

	// The earlier runs are read newest first, a page at a time, and no further than the budget can hold: what
	// is older would be the first to go. A run the ledger keeps or has not processed is shown in that layer; a run
	// the ledger never took (cancelled, replaced, from before it) stays as it was; the newest two stay even when
	// the ledger had already finished with them.
	const entries: HistoryEntry[] = [];
	const seen = new Set<string>();
	const pinned = new Set<string>();
	let loaded = 0;
	let reachedBudget = false;
	for (let offset = 0; !reachedBudget; offset += PRIOR_PAGE) {
		const page = recentPriorRuns(
			tx,
			run,
			PRIOR_PAGE,
			withoutSpecialist,
			offset,
		).reverse();
		for (const prior of page) {
			const id = prior.inputMessageId;
			seen.add(id);
			const answer =
				prior.status === "completed" ? prior.answerMessageId : null;
			if (
				pinned.size < LATEST_EXCHANGES &&
				(!blocked.has(id) || (answer !== null && !blocked.has(answer)))
			)
				pinned.add(id);
			const ref = refs.get(id);
			if (!ref && verbatim?.known.has(id) && !pinned.has(id)) continue;
			const entry = ref
				? entryOf(ref, ref.index)
				: entryOf(
						{
							inputMessageId: id,
							answerMessageId: answer,
							layer: "unprocessed",
						},
						-1,
					);
			if (!entry) continue;
			entry.pinned = pinned.has(id);
			entries.push(entry);
			loaded += entry.tokens;
			if (pinned.size >= LATEST_EXCHANGES && loaded >= room) {
				reachedBudget = true;
				break;
			}
		}
		if (page.length < PRIOR_PAGE) break;
	}
	// Every run was read: a ledger exchange that is not among them (none is expected) is shown as it was.
	if (!reachedBudget)
		for (const ref of refs.values()) {
			if (seen.has(ref.inputMessageId)) continue;
			const entry = entryOf(ref, ref.index);
			if (entry) entries.push(entry);
		}
	// The ledger's order first (kept ones in the window's order), then the other runs oldest first.
	entries.sort((a, b) =>
		a.index >= 0 && b.index >= 0
			? a.index - b.index
			: a.index >= 0
				? -1
				: b.index >= 0
					? 1
					: a.ordinal - b.ordinal,
	);
	// Over the budget the oldest go, kept and unprocessed alike; the newest two stay.
	let total = entries.reduce((sum, entry) => sum + entry.tokens, 0);
	const shown = new Set(entries);
	let droppedMessages = 0;
	let omittedTokens = 0;
	for (const entry of [...entries].sort((a, b) => a.ordinal - b.ordinal)) {
		if (total <= room) break;
		if (entry.pinned) continue;
		shown.delete(entry);
		total -= entry.tokens;
		droppedMessages += entry.turns.length;
		omittedTokens += entry.tokens;
	}
	if (droppedMessages > 0)
		log.info("dialogue.history_trimmed", {
			droppedMessages,
			omitted: omittedTokens,
			limit: room,
		});
	const visible = entries.filter((entry) => shown.has(entry));
	const turns = [
		...visible
			.filter((entry) => entry.layer === "keep")
			.sort((a, b) => a.index - b.index)
			.flatMap((entry) => entry.turns),
		...visible
			.filter((entry) => entry.layer === "unprocessed")
			.sort((a, b) => a.ordinal - b.ordinal)
			.flatMap((entry) => entry.turns),
	];

	const currentInput = conversation.messageInTransaction(
		tx,
		run.inputMessageId,
	);
	if (!currentInput) throw new Error("run_input_missing");
	const input: ChatMessage = {
		role: "user",
		content: withAttachmentNotes(
			currentInput.message.text,
			currentInput.message.attachments,
		),
		...(currentInput.message.attachments?.length
			? {
					attachments: currentInput.message.attachments,
					sourceMessageId: currentInput.message.id,
				}
			: {}),
	};
	const shownMessageIds = [
		...visible.flatMap((entry) => entry.turns.map((turn) => turn.messageId)),
		currentInput.message.id,
	];
	// A prefetch that stands on messages already shown would repeat them.
	const shownSet = new Set(shownMessageIds);
	const prefetchDropped = !!window?.prefetch.pins.some((pin) =>
		shownSet.has(pin.messageId),
	);

	return {
		assembly: {
			stage: "initial",
			persona: general ?? { agentName: "", userName: "", persona: "butler" },
			hostRules: CONVERSATION_HOST_RULES,
			stable,
			history: { turns },
			working,
			volatile: [...notices, ...(prefetchDropped ? [] : prefetch)],
			input,
		},
		shownMessageIds,
		prefetchDropped,
	};
}

/** True when the window contributes nothing to the prompt (no layer text, no notice). */
export function windowIsEmpty(window: WindowSnapshot): boolean {
	return (
		window.longTerm.text === "" &&
		window.shortTerm.text === "" &&
		window.history.summaryText === "" &&
		window.prefetch.text === "" &&
		window.notices.length === 0
	);
}
