import type { Database } from "bun:sqlite";
import { systemCopyCheck } from "./conversation-output";
import type { NativeTool } from "../../../infrastructure/chat-stream";
import {
	estimateTextTokens,
	headWithin,
} from "../../../infrastructure/context-budget";
import { sha256Hex } from "../../../infrastructure/digest";
import type { ConversationCut, Utterance } from "../../conversation";
import { keepOrder, type ProfileItem, type WindowSnapshot } from "../../memory";
import { latestConversationId } from "../repository";
import type { ChatMessage, DialogueDeps } from "./context";
import { systemText } from "./context-system";
import { conversationHasActiveRun } from "./active-run";
import { toolchainTitlesInTransaction } from "./delegate-conversation";
import { generationTools } from "./generation-tools";
import { localHarness, type ConversationHarness } from "./harness";
import { INPUT_HEADINGS, dataText, joinSections, section } from "./input-text";
import { memoryItemLine } from "./result-text";
import { stateLinesInTransaction, stateText } from "./state-text";
import { exchangeMessages } from "./tool-exchange";

/** Bounds of the recent conversation and its cuts (the conversation input specification, sections 6.1 and 6.1.1). */
export const RECENT = {
	/** One utterance shows at most this much; the rest is cut with `…`. */
	utteranceTokens: 300,
	/** The context keeper is asked for a cut past this many utterances or tokens. */
	softCount: 12,
	softTokens: 2400,
	/** The host cuts by its fixed rule past this many, whether the keeper came or not. */
	hardCount: 20,
	hardTokens: 4000,
	/** A fixed-rule cut keeps this many newest utterances (starting with the agent's). */
	keep: 4,
	/** A silence this long before an input starts the recent conversation again. */
	gapMs: 30 * 60 * 1000,
} as const;

/** `## Memory` holds the profile's leanings only, within this bound (section 5.1). */
export const MEMORY_TOKENS = 300;
const MEMORY_KINDS = new Set(["preference", "habit", "tendency", "constraint"]);

/** The system part of every call on the conversation's prompt (section 4), in the harness's sections. */
export function conversationSystem(
	deps: DialogueDeps,
	tx: Database,
	harness: ConversationHarness,
): string {
	const persona = deps.larm.snapshotInTransaction?.(tx).general ?? {
		agentName: "",
		userName: "",
		persona: "butler" as const,
	};
	return systemText(
		persona,
		deps.conversationAgent.system(),
		toolchainTitlesInTransaction(deps, tx),
		harness.system,
		harness.systemTexts,
	);
}

/** What the cached prefix is fixed by: the system part and the tool definitions. */
export const systemDigestOf = (system: string) =>
	sha256Hex(system + JSON.stringify(generationTools));

/** What `## Memory` shows of a window: a cut is placed when it would show something else. */
export const memoryDigestOf = (window: WindowSnapshot | null) =>
	sha256Hex(memoryLines(window?.profile.items ?? []).lines.join("\n"));

/** The leanings of the published profile within `MEMORY_TOKENS`, in its published order, and their ids. */
export function memoryLines(items: readonly ProfileItem[]): {
	lines: string[];
	ids: string[];
} {
	// The user's own words only: an inference or an observation read as a fact steers the reply (C4).
	const leanings = items.filter(
		(item) => MEMORY_KINDS.has(item.kind) && item.source === "user_said",
	);
	const line = (item: ProfileItem) =>
		memoryItemLine({
			text: item.text,
			negated: item.negated,
			source: item.source,
			...(item.since ? { since: item.since } : {}),
			...(item.until ? { until: item.until } : {}),
		});
	// Measured as the section reads (its heading and lines together): the estimate is not a sum of its parts.
	const kept = new Set<string>();
	const text = () =>
		[
			INPUT_HEADINGS.memory,
			...leanings.filter((i) => kept.has(i.id)).map(line),
		].join("\n");
	for (const item of keepOrder(leanings)) {
		kept.add(item.id);
		if (estimateTextTokens(text()) > MEMORY_TOKENS) kept.delete(item.id);
	}
	const shown = leanings.filter((item) => kept.has(item.id));
	return { lines: shown.map(line), ids: shown.map((item) => item.id) };
}

/** An utterance's size in the recent conversation: its words, and the notice and tool calls the harness draws. */
const utteranceTokens = (u: Utterance, history: HarnessHistory) =>
	estimateTextTokens(u.text) +
	(history.notices && u.notice ? estimateTextTokens(u.notice) : 0) +
	(history.toolExchanges
		? u.toolCalls.reduce(
				(sum, call) =>
					sum + estimateTextTokens(call.name + call.arguments + call.result),
				0,
			)
		: 0);
const tokensOf = (utterances: readonly Utterance[], history: HarnessHistory) =>
	utterances.reduce((sum, u) => sum + utteranceTokens(u, history), 0);
type HarnessHistory = ConversationHarness["history"];

/** The utterances the recent conversation shows: from the agent's first one, those not waiting for an answer. */
export function recentUtterances(
	after: readonly Utterance[],
	pending: ReadonlySet<string>,
	users?: number,
): Utterance[] {
	const shown = after.filter(
		(u) => !(u.speaker === "user" && u.messageId && pending.has(u.messageId)),
	);
	// A harness that keeps the last few of the user's utterances starts after the one before them: at the agent's
	// reply to it, so the recent conversation still opens with the agent's words and `## Memory` stays a message of
	// its own, the same from turn to turn (the cached prefix).
	let from = 0;
	if (users !== undefined) {
		const asked = shown.flatMap((u, i) => (u.speaker === "user" ? [i] : []));
		if (asked.length > users) from = asked[asked.length - users - 1]! + 1;
	}
	const kept = shown.slice(from);
	const start = kept.findIndex((u) => u.speaker === "agent");
	return start < 0 ? [] : kept.slice(start);
}

/**
 * The recent conversation as native messages: one per side's run of utterances, each utterance within its bound. An
 * agent's utterance that ended a turn with a search or a hand-over follows those calls and their results (the
 * tool-call reliability design, P1); the first call joins an agent's words just before it. The harness's history
 * flags leave out the exchanges and the notices.
 */
export function recentMessages(
	utterances: readonly Utterance[],
	history: ConversationHarness["history"],
): ChatMessage[] {
	const messages: ChatMessage[] = [];
	for (const u of utterances) {
		const role = u.speaker === "user" ? "user" : "assistant";
		const text = dataText(headWithin(u.text, RECENT.utteranceTokens).text);
		const exchange = history.toolExchanges
			? exchangeMessages(u.seq, u.toolCalls)
			: [];
		// A report follows the notice it answered (section 5.5 #4); at the very start it has nothing to follow.
		if (history.notices && u.notice && messages.length) {
			const notice = dataText(u.notice);
			const before = messages.at(-1)!;
			if (before.role === "user") before.content += `\n${notice}`;
			else messages.push({ role: "user", content: notice });
		}
		const last = messages.at(-1);
		if (exchange.length) {
			const [first, ...rest] = exchange;
			if (last && last.role === "assistant" && !last.tool_calls)
				last.tool_calls = first!.tool_calls!;
			else messages.push(first!);
			messages.push(...rest, { role, content: text });
		} else if (last && last.role === role && !last.tool_calls)
			last.content += `\n${text}`;
		else messages.push({ role, content: text });
	}
	return messages;
}

/** The seq a fixed-rule cut is placed after: the newest `RECENT.keep` utterances stay, from an agent's. */
export function keepNewestCut(
	shown: readonly Utterance[],
	fallback: number,
): number {
	let at = Math.max(0, shown.length - RECENT.keep);
	while (at < shown.length && shown[at]!.speaker === "user") at++;
	if (at >= shown.length) return shown.at(-1)?.seq ?? fallback;
	return shown[at]!.seq - 1;
}

/** Why the host cuts by its fixed rule now (section 6.1.1 ② to ⑤), or null. */
function fixedCutReason(
	cut: ConversationCut,
	shown: readonly Utterance[],
	input: {
		systemDigest: string;
		memoryDigest: string;
		nowMs: number;
		history: HarnessHistory;
	},
): string | null {
	// A gap comes first: it keeps nothing of what was said before, which serves every other reason too (a memory or
	// system part changed while away must not leave the old words standing).
	const last = shown.at(-1);
	if (last && input.nowMs - Date.parse(last.at) >= RECENT.gapMs)
		return "resumed";
	if (cut.due) return cut.due;
	if (cut.systemDigest !== input.systemDigest) return "system_changed";
	if (cut.memoryDigest !== input.memoryDigest) return "memory_changed";
	if (
		shown.length > RECENT.hardCount ||
		tokensOf(shown, input.history) > RECENT.hardTokens
	)
		return "over_limit";
	return null;
}

/**
 * Places the recent conversation's cut by the host's fixed rules (section 6.1.1 ② to ⑤), inside the caller's write
 * transaction: a first input starts at the beginning; a forget inside it, another system part or memory version or
 * the hard limit keep the newest few; a conversation resumed after a gap keeps none of what was said before it (the
 * work and the memory carry on). A cut that changes the memory republishes it first (the waiting additions join
 * `## Memory` only here). Returns the cut and why it moved (null when it stayed).
 */
export function placeCutInTransaction(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
	input: {
		system: string;
		window: WindowSnapshot | null;
		nowMs: number;
		pending: ReadonlySet<string>;
		/** What the harness draws of the recent conversation: only that counts toward its limit. */
		history: HarnessHistory;
	},
): {
	cut: ConversationCut;
	reason: string | null;
	window: WindowSnapshot | null;
} {
	const store = deps.conversation.input;
	const systemDigest = systemDigestOf(input.system);
	const at = new Date(input.nowMs).toISOString();
	let window = input.window;
	const existing = store.cutInTransaction(tx, conversationId);
	if (!existing)
		return {
			cut: store.writeCutInTransaction(tx, conversationId, {
				seq: 0,
				systemDigest,
				memoryDigest: memoryDigestOf(window),
				at,
			}),
			reason: "started",
			window,
		};
	const shown = store
		.utterancesAfterInTransaction(tx, conversationId, existing.seq)
		.filter(
			(u) =>
				!(
					u.speaker === "user" &&
					u.messageId &&
					input.pending.has(u.messageId)
				),
		);
	const reason = fixedCutReason(existing, shown, {
		systemDigest,
		memoryDigest: memoryDigestOf(window),
		nowMs: input.nowMs,
		history: input.history,
	});
	if (!reason) return { cut: existing, reason: null, window };
	// Nothing said before a gap stays, nor what the context keeper made of it.
	if (reason === "resumed") store.dropStatesInTransaction(tx, conversationId);
	const moved = moveCutInTransaction(deps, tx, conversationId, {
		seq:
			reason === "resumed"
				? (shown.at(-1)?.seq ?? existing.seq)
				: keepNewestCut(shown, existing.seq),
		window,
		nowMs: input.nowMs,
		system: input.system,
	});
	return { ...moved, reason };
}

/**
 * Moves the cut after `seq` (a fixed-rule cut, or the context keeper's): the system part it stands on is the current
 * one, and `## Memory` is drawn again, the waiting additions joining it (the only time they do).
 */
export function moveCutInTransaction(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
	input: {
		seq: number;
		window: WindowSnapshot | null;
		nowMs: number;
		system?: string;
	},
): { cut: ConversationCut; window: WindowSnapshot | null } {
	let window = input.window;
	if (window && (window.republishRequested || window.newMemories.length))
		window =
			deps.memory?.republishWindowInTransaction(tx, conversationId) ?? window;
	const cut = deps.conversation.input.writeCutInTransaction(
		tx,
		conversationId,
		{
			seq: input.seq,
			systemDigest: systemDigestOf(
				input.system ?? conversationSystem(deps, tx, localHarness),
			),
			memoryDigest: memoryDigestOf(window),
			at: new Date(input.nowMs).toISOString(),
		},
	);
	return { cut, window };
}

/**
 * Clears the recent conversation at the user's request: the cut moves after the newest utterance, so the next input
 * has none of the earlier words. Nothing is deleted, and what is said from then on is kept as always. False while a
 * run of the conversation is queued or running (its input must not change under it).
 */
export function clearRecentInTransaction(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
	nowMs: number,
): boolean {
	if (conversationHasActiveRun(tx, conversationId)) return false;
	const store = deps.conversation.input;
	const newest = store.latestUtterancesInTransaction(tx, conversationId, 1)[0];
	const cut = store.cutInTransaction(tx, conversationId);
	if (!newest || (cut && cut.seq >= newest.seq)) return true;
	// What the context keeper made of the earlier words goes with them.
	store.dropStatesInTransaction(tx, conversationId);
	let window: WindowSnapshot | null = null;
	try {
		window = deps.memory?.storedWindowInTransaction(tx, conversationId) ?? null;
	} catch {
		// An unreadable memory window is drawn again by the next input.
	}
	moveCutInTransaction(deps, tx, conversationId, {
		seq: newest.seq,
		window,
		nowMs,
	});
	return true;
}

/** The prefix every call on the conversation's prompt shares, and what it was drawn from. */
export type ConversationPrefix = {
	/** System, `## Memory` (when there is a recent conversation to put it before) and the recent conversation. */
	messages: ChatMessage[];
	tools: NativeTool[];
	/** `## Memory` when no recent conversation follows it: the last message starts with it instead. */
	carry: string | null;
	cut: ConversationCut | null;
	recent: Utterance[];
	/** When the newest utterance not waiting for an answer was said, behind the cut too (the gap `## State` names). */
	lastAt: number | null;
	/** When the recent conversation begins (its first utterance, else the cut): what came before is no record of it. */
	since: number | null;
	/** The memory items `## Memory` shows. */
	memoryItemIds: string[];
};

/**
 * The conversation's prefix as it stands (sections 3, 5 and 6): the same function draws it for a generation and for
 * the background calls on the conversation, so their prefix is byte for byte the next generation's while nothing
 * changes in between. It only reads: the cut is placed by `placeCutInTransaction`.
 */
export function conversationPrefixFrom(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
	input: {
		harness: ConversationHarness;
		system: string;
		window: WindowSnapshot | null;
		pending: ReadonlySet<string>;
	},
): ConversationPrefix {
	const store = deps.conversation.input;
	const cut = store.cutInTransaction(tx, conversationId);
	const { history } = input.harness;
	// An utterance of the agent that copies the system part is not drawn: it was copied again turn after turn
	// (section 5.5 #1). The generation's gate keeps new ones out; this keeps out those kept before it, and the
	// agency's, which no generation gate checks.
	const copies = history.copyFilter
		? systemCopyCheck(input.system, toolchainTitlesInTransaction(deps, tx))
		: null;
	const recent = recentUtterances(
		store
			.utterancesAfterInTransaction(tx, conversationId, cut?.seq ?? 0)
			.filter((u) => !(copies && u.speaker === "agent" && copies(u.text))),
		input.pending,
		history.users,
	);
	const { lines, ids } = memoryLines(input.window?.profile.items ?? []);
	// Always there before a recent conversation, so the conversation never opens with the agent's message.
	const memory = section(
		INPUT_HEADINGS.memory,
		lines.length ? lines : ["- なし"],
	);
	const conversation = recentMessages(recent, history);
	const messages: ChatMessage[] = [{ role: "system", content: input.system }];
	if (memory && conversation.length)
		messages.push({ role: "user", content: memory });
	messages.push(...conversation);
	// A conversation resumed after a gap keeps nothing before it, but the gap is still the time since the last words.
	const last = store
		.latestUtterancesInTransaction(tx, conversationId, input.pending.size + 1)
		.reverse()
		.find(
			(u) =>
				!(
					u.speaker === "user" &&
					u.messageId &&
					input.pending.has(u.messageId)
				),
		);
	return {
		messages,
		// A routed turn sends no tool definitions: the background calls share its prefix as it is.
		tools: input.harness.turn === "routed" ? [] : generationTools,
		carry: conversation.length || !lines.length ? null : memory,
		cut,
		recent,
		lastAt: last ? Date.parse(last.at) : null,
		// A cut at the start drops nothing: only a moved cut leaves earlier words behind.
		since: recent[0]
			? Date.parse(recent[0].at)
			: cut && cut.seq > 0
				? Date.parse(cut.at)
				: null,
		memoryItemIds: ids,
	};
}

/**
 * The whole input: the prefix, then the last `user` message (`## Memory` when it was carried, `## State`, then
 * `## User`, `## Host notice` or a background call's own sections). A last recent message from the user (an utterance
 * answered without words) joins it, so no two messages of one role follow each other.
 */
export function withLastMessage(
	prefix: ConversationPrefix,
	sections: ReadonlyArray<string | null>,
	extra: Omit<ChatMessage, "role" | "content"> = {},
): ChatMessage[] {
	const content = joinSections([prefix.carry, ...sections]);
	const messages = prefix.messages.map((message) => ({ ...message }));
	const last = messages.at(-1);
	if (last && last.role === "user" && messages.length > 1) {
		last.content = `${last.content}\n\n${content}`;
		Object.assign(last, extra);
		return messages;
	}
	return [...messages, { role: "user", content, ...extra }];
}

/** The pending user messages, by id: what `## User` shows and the recent conversation leaves out. */
export function pendingMessageIdsInTransaction(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
): Set<string> {
	return new Set(
		deps.continuity.events
			.pendingInTransaction(tx, conversationId)
			.flatMap((event) => event.messageIds),
	);
}

/**
 * The prefix a background call on the conversation reads (section 10): the conversation's prefix as its next
 * generation would draw it, with the memory window it last read. It stays on LARM, so it is drawn with the local
 * harness. null when memory is unavailable (the conversation itself would not run then).
 */
export function backgroundPrefixInTransaction(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
): ConversationPrefix | null {
	let window: WindowSnapshot | null = null;
	try {
		window = deps.memory?.storedWindowInTransaction(tx, conversationId) ?? null;
	} catch {
		return null;
	}
	return conversationPrefixFrom(deps, tx, conversationId, {
		harness: localHarness,
		system: conversationSystem(deps, tx, localHarness),
		window,
		pending: pendingMessageIdsInTransaction(deps, tx, conversationId),
	});
}

/** A background call's last message: its own sections, then `## Task` with its instruction. */
export function taskMessages(
	prefix: ConversationPrefix,
	sections: ReadonlyArray<string | null>,
	task: string,
): ChatMessage[] {
	return withLastMessage(prefix, [
		...sections,
		`${INPUT_HEADINGS.task}\n${task}`,
	]);
}

/** A message of a background call: the prefix's words and kept tool calls, and its task (no image, no attachment). */
export type BackgroundMessage = Pick<
	ChatMessage,
	"role" | "content" | "tool_calls" | "tool_call_id"
>;

/** A message as a background call sends it: what the conversation's own call sends of it, byte for byte. */
export const backgroundMessage = ({
	role,
	content,
	tool_calls,
	tool_call_id,
}: ChatMessage): BackgroundMessage => ({
	role,
	content,
	...(tool_calls ? { tool_calls } : {}),
	...(tool_call_id ? { tool_call_id } : {}),
});

/**
 * A background call's whole input on the conversation's prompt (section 10): the shared prefix, then the last
 * message with `## State` (as things are now, showing no screen and consuming nothing) and its own `## Task`. null
 * when memory is unavailable.
 */
export function backgroundTaskInTransaction(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
	task: string,
	sections: ReadonlyArray<string | null> = [],
): { messages: BackgroundMessage[]; tools: NativeTool[] } | null {
	const prefix = backgroundPrefixInTransaction(deps, tx, conversationId);
	if (!prefix) return null;
	const nowMs = Date.parse(deps.clock());
	const state = stateText(
		stateLinesInTransaction(deps, tx, {
			conversationId,
			nowMs,
			lastAt: prefix.lastAt,
			since: prefix.since,
			lastAgent:
				[...prefix.recent].reverse().find((u) => u.speaker === "agent") ?? null,
			state: deps.conversation.input.latestStateInTransaction(
				tx,
				conversationId,
			),
			refs: deps.work?.refsInTransaction(tx, conversationId) ?? {
				todo: () => null,
				confirmation: () => null,
				resource: () => null,
			},
		}),
	);
	return {
		messages: taskMessages(prefix, [state, ...sections], task).map(
			backgroundMessage,
		),
		tools: prefix.tools,
	};
}

/** The dialogue service's part for the background calls on a conversation's prompt (steward, agency, prewarm). */
export function conversationTaskPort(deps: DialogueDeps) {
	return {
		/** The conversation the user talked in last (the newest run's). */
		latestConversationIdInTransaction: latestConversationId,
		/**
		 * A background call's input on the conversation's prompt: the prefix its generations share, `## State`, then
		 * `## Task` with `task`. null when memory is unavailable.
		 */
		conversationTaskInTransaction: (
			db: Database,
			conversationId: string,
			task: string,
		) => backgroundTaskInTransaction(deps, db, conversationId, task),
	};
}
