import {
	MEMORY_HISTORY_MAX_TOKENS,
	type ContextBlock,
} from "../../inference";
import { getLogger } from "../../../infrastructure/logger";
import type { Tx } from "../../queue";
import type { ConversationService } from "../../conversation";
import type { MemoryService, WindowSnapshot } from "../../memory";
import type { Run } from "../contracts";
import { recentPriorRuns } from "../repository";
import type { ChatMessage } from "./context";
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
import { layoutCurrent } from "./context-format-current";

const log = getLogger("dialogue");
/** The newest exchanges that are never dropped for size. */
const LATEST_EXCHANGES = 2;

/** The prompt by layer, in the order `messages` lists them (the layers are what the research context reassembles). */
export type ContextSections = {
	/** L0 */
	system: ChatMessage;
	/** L1 long-term memory */
	longTerm: ChatMessage[];
	/** The adopted goals, right after L1: they change rarely, so the layers behind them keep their cache */
	goals: ChatMessage[];
	/** L3 the exchanges kept verbatim, in the order they were appended */
	history: ChatMessage[];
	/** L2 working memory: the summary, then the short-term notes and the recently remembered */
	working: ChatMessage[];
	/** Exchanges no step has taken out of the prompt yet, and the newest two when the steward dropped them */
	unprocessed: ChatMessage[];
	/** L5 */
	input: ChatMessage;
	/** L4 decided here (notice, prefetch); the caller adds the rest right before the input. */
	tail: ChatMessage[];
};

type HistoryEntry = {
	layer: "keep" | "unprocessed";
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
	// -1: every earlier run (SQLite has no limit then); the budget decides how many are read below.
	const prior = recentPriorRuns(tx, run, -1, withoutSpecialist);
	const refs = [
		...(verbatim?.keep ?? []).map((ref) => ({
			...ref,
			layer: "keep" as const,
		})),
		...(verbatim?.unprocessed ?? []).map((ref) => ({
			...ref,
			layer: "unprocessed" as const,
		})),
	];
	// Runs the ledger never took (cancelled, replaced, from before it) stay as they were. They are read newest
	// first and no further than the budget can hold: the older ones would be the first to go.
	const unknown = prior
		.filter((entry) => !verbatim?.known.has(entry.inputMessageId))
		.map((entry) => ({
			inputMessageId: entry.inputMessageId,
			answerMessageId:
				entry.status === "completed" ? entry.answerMessageId : null,
			layer: "unprocessed" as const,
		}));
	const newest = new Set(
		prior
			.filter(
				(entry) =>
					!blocked.has(entry.inputMessageId) ||
					(entry.status === "completed" &&
						entry.answerMessageId !== null &&
						!blocked.has(entry.answerMessageId)),
			)
			.slice(-LATEST_EXCHANGES)
			.map((entry) => entry.inputMessageId),
	);
	const known = new Set(refs.map((ref) => ref.inputMessageId));

	const entryOf = (ref: {
		inputMessageId: string;
		answerMessageId: string | null;
		layer: "keep" | "unprocessed";
	}): HistoryEntry | null => {
		const turns: HistoryTurn[] = [];
		let ordinal: number | null = null;
		if (!blocked.has(ref.inputMessageId)) {
			const input = conversation.messageInTransaction(tx, ref.inputMessageId);
			if (input) {
				turns.push({
					role: "user",
					content: input.message.text,
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
			ordinal,
			turns,
			tokens: turns.reduce((sum, turn) => sum + turnTokens(turn.content), 0),
			pinned: newest.has(ref.inputMessageId),
		};
	};

	const entries: HistoryEntry[] = [];
	for (const ref of refs) {
		const entry = entryOf(ref);
		if (entry) entries.push(entry);
	}
	let loaded = 0;
	const fromPrior: HistoryEntry[] = [];
	for (const ref of [...unknown].reverse()) {
		const entry = entryOf(ref);
		if (!entry) continue;
		fromPrior.push(entry);
		loaded += entry.tokens;
		if (loaded >= room && fromPrior.length > LATEST_EXCHANGES) break;
	}
	entries.push(...fromPrior);
	// The newest two stay even when the ledger had already finished with them.
	for (const entry of prior
		.filter((e) => newest.has(e.inputMessageId) && !known.has(e.inputMessageId))
		.map((e) =>
			entryOf({
				inputMessageId: e.inputMessageId,
				answerMessageId:
					e.status === "completed" ? e.answerMessageId : null,
				layer: "unprocessed",
			}),
		))
		if (entry && !entries.some((e) => e.turns[0]!.messageId === entry.turns[0]!.messageId))
			entries.push(entry);
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
		content: currentInput.message.text,
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
			history: { boundary: window?.history.boundary ?? {}, turns },
			working,
			volatile: [...notices, ...(prefetchDropped ? [] : prefetch)],
			input,
			currentRequest: { messageId: currentInput.message.id },
		},
		shownMessageIds,
		prefetchDropped,
	};
}

/**
 * The model-visible context of a run up to the volatile part, in the fixed order
 * `[L0 system, L1 long-term?, goals?, L3 kept exchanges, L2 working memory?, unprocessed exchanges, L5 this input]`:
 * `compileAssembly` written in the `current` format. The notices and the prefetched exchanges are `sections.tail`.
 */
export function compileContext(
	tx: Tx,
	run: Run,
	conversation: ConversationService,
	general: PersonaSpec | undefined,
	window: WindowSnapshot | null,
	memory?: MemoryHistory,
	goalsLayer?: ChatMessage | null,
	/** Leave the specialist sessions' runs out of the fallback history. */
	withoutSpecialist = false,
	/** The whole memory and history budget (tokens) of the model window. */
	memoryHistoryTokens?: number,
): {
	messages: ChatMessage[];
	sections: ContextSections;
	/** Every message the prompt shows verbatim, this input included: a recall must not repeat them. */
	shownMessageIds: string[];
	/** The prefetch overlaps the shown messages and is left out of this turn (its pins must not be checked either). */
	prefetchDropped: boolean;
} {
	const { assembly, shownMessageIds, prefetchDropped } = compileAssembly(
		tx,
		run,
		conversation,
		general,
		window,
		memory,
		goalsLayer
			? {
					source: "goals",
					authority: "reference",
					freshness: "stable",
					body: { kind: "text", text: goalsLayer.content },
				}
			: null,
		withoutSpecialist,
		memoryHistoryTokens,
	);
	const sections = layoutCurrent(assembly);
	return {
		messages: [
			sections.system,
			...sections.longTerm,
			...sections.goals,
			...sections.history,
			...sections.working,
			...sections.unprocessed,
			sections.input,
		],
		sections,
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
