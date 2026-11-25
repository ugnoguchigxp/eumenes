import { inheritedHistorySources } from "./history-sources";
import { backgroundInput } from "./background-input";
import type { Database } from "bun:sqlite";
import { systemContext } from "../../../infrastructure/system-context";
import {
	copyInputOrigins,
	markInput,
	prependInput,
	type InputOrigin,
} from "../../../infrastructure/model-input";
import { systemCopyCheck } from "./conversation-output";
import { headWithin } from "../../../infrastructure/context-budget";
import { sha256Hex } from "../../../infrastructure/digest";
import type { ConversationCut, Utterance } from "../../conversation";
import { imageReferenceText } from "../../conversation";
import type { WindowSnapshot } from "../../memory";
import { latestConversationId, readMemoryRefs } from "../repository";
import { assignWindowRefs, excludedOnlyIn } from "./memory-refs";
import type { ChatMessage, DialogueDeps } from "./context";
import { conversationHasImages, systemText } from "./context-system";
import { conversationHasActiveRun } from "./active-run";
import { backgroundHarness, type ConversationHarness } from "./harness";
import { INPUT_HEADINGS, dataText, joinSections, section } from "./input-text";
import {
	alwaysBudgetInTransaction,
	currentProfileItems,
	memoryDigestOf,
	memoryLines,
} from "./memory-lines";
import {
	RECENT,
	compactOnOverLimitInTransaction,
	keepNewestCut,
	overHardLimit,
	summaryRefsValid,
	tokensOf,
	utteranceTokens,
	workingLimits,
	type WorkingLimits,
} from "./summary-format";
import { replayableCalls } from "./tool-exchange";
import { stateLinesInTransaction, stateText } from "./state-text";

export {
	RECENT,
	keepNewestCut,
	tokensOf,
	utteranceTokens,
	workingLimits,
	type WorkingLimits,
};

/** The system part of every call on the conversation's prompt (section 4). */
export function conversationSystem(
	deps: DialogueDeps,
	tx: Database,
	conversationId?: string,
): string {
	const persona = deps.larm.snapshotInTransaction?.(tx).general ?? {
		agentName: "",
		userName: "",
		persona: "butler" as const,
	};
	const base = systemText(
		persona,
		deps.conversationAgent.system(),
		!!conversationId && conversationHasImages(deps, tx, conversationId),
	);
	return conversationId && deps.externalOutput?.active(tx, conversationId)
		? `${base}\n${systemContext("dialogue.contexts.live-output", {})}`
		: base;
}

/** What the cached prefix is fixed by: the system part. */
export const systemDigestOf = (system: string) => sha256Hex(system);

/** The recent utterances in the configured window, excluding pending user input. */
export function recentUtterances(
	after: readonly Utterance[],
	pending: ReadonlySet<string>,
	users?: number,
): Utterance[] {
	const shown = after.filter(
		(u) => !(u.speaker === "user" && u.messageId && pending.has(u.messageId)),
	);
	// A bounded window starts after the user utterance preceding the ones it retains.
	let from = 0;
	if (users !== undefined) {
		const asked = shown.flatMap((u, i) => (u.speaker === "user" ? [i] : []));
		if (asked.length > users) from = asked[asked.length - users - 1]! + 1;
	}
	return shown.slice(from);
}

/**
 * The recent conversation as native messages: one per side's run of utterances, each utterance within its bound. The
 * searches, hand-overs and notices an utterance carries are not drawn: the talk turn reads the words only.
 */
export function recentMessages(
	utterances: readonly Utterance[],
	imageNotes: ReadonlyMap<string, string> = new Map(),
	/** Replay carried tool calls and results in the working conversation history. */
	withCalls = false,
	originOf?: (utterance: Utterance) => InputOrigin,
	/** Include agency-owned tools (`start_preparation`, `read_note`, goal tools) when the agency serves replies. */
	includeAgency = withCalls,
): ChatMessage[] {
	const messages: ChatMessage[] = [];
	for (const u of utterances) {
		const role = u.speaker === "user" ? "user" : "assistant";
		const note = u.messageId ? imageNotes.get(u.messageId) : null;
		const text = dataText(
			[headWithin(u.text, RECENT.utteranceTokens).text, note]
				.filter(Boolean)
				.join("\n"),
		);
		const calls =
			withCalls && role === "assistant"
				? replayableCalls(u, includeAgency)
				: [];
		const origin = originOf?.(u);
		if (calls.length) {
			// The reply's own tool calls come back as its history: it sees what it did (the package's rule).
			const ids = calls.map((_, k) =>
				`${u.messageId ?? u.seq}_${k}`.replace(/[^A-Za-z0-9_-]/gu, "_"),
			);
			messages.push({
				role: "assistant",
				content: "",
				tool_calls: calls.map((c, k) => ({
					id: ids[k]!,
					type: "function" as const,
					function: { name: c.name, arguments: c.arguments },
				})),
			} as unknown as ChatMessage);
			calls.forEach((c, k) =>
				// Typed as the prefix's messages: the tool role is the chat shape the model reads.
				messages.push({
					role: "tool",
					content: c.result,
					tool_call_id: ids[k]!,
				} as unknown as ChatMessage),
			);
			const words: ChatMessage = { role, content: text };
			messages.push(origin ? markInput(words, origin) : words);
			continue;
		}
		const last = messages.at(-1);
		if (
			last &&
			last.role === role &&
			!(last as { tool_calls?: unknown }).tool_calls
		) {
			const from = last.content.length + 1;
			last.content += `\n${text}`;
			if (origin) markInput(last, origin, from);
		} else {
			const words: ChatMessage = { role, content: text };
			messages.push(origin ? markInput(words, origin) : words);
		}
	}
	return messages;
}

/** Why the host cuts by its fixed rule now (section 6.1.1 ② to ⑤), or null. */
function fixedCutReason(
	cut: ConversationCut,
	shown: readonly Utterance[],
	input: {
		systemDigest: string;
		memoryDigest: string;
		nowMs: number;
		limits?: WorkingLimits;
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
	if (overHardLimit(shown, input.limits)) return "over_limit";
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
		limits?: WorkingLimits;
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
	const memoryDigest = memoryDigestOf(
		window,
		alwaysBudgetInTransaction(deps, tx),
	);
	const existing = store.cutInTransaction(tx, conversationId);
	if (!existing)
		return {
			cut: store.writeCutInTransaction(tx, conversationId, {
				seq: 0,
				systemDigest,
				memoryDigest,
				at,
			}),
			reason: "started",
			window,
		};
	const rawShown = store.utterancesAfterInTransaction(
		tx,
		conversationId,
		existing.seq,
	);
	const withheld = excludedOnlyIn(
		deps,
		tx,
		rawShown.flatMap((u) => (u.messageId ? [u.messageId] : [])),
	);
	const shown = rawShown.filter(
		(u) =>
			!(u.messageId && withheld.has(u.messageId)) &&
			!(u.speaker === "user" && u.messageId && input.pending.has(u.messageId)),
	);
	const reason = fixedCutReason(existing, shown, {
		systemDigest,
		memoryDigest,
		nowMs: input.nowMs,
		limits: input.limits,
	});
	if (!reason) return { cut: existing, reason: null, window };
	// Nothing said before a gap stays, nor the input states or compacted summaries saved for it.
	if (reason === "resumed") {
		store.dropStatesInTransaction(tx, conversationId);
		store.clearSummariesInTransaction?.(tx, conversationId);
	} else if (reason !== "over_limit")
		store.clearStagedSummariesInTransaction?.(tx, conversationId);
	const targetSeq =
		reason === "resumed"
			? (shown.at(-1)?.seq ?? existing.seq)
			: reason === "over_limit"
				? compactOnOverLimitInTransaction(
						deps,
						tx,
						conversationId,
						existing,
						shown,
						at,
						input.limits,
					)
				: keepNewestCut(shown, existing.seq, input.limits);
	const moved = moveCutInTransaction(deps, tx, conversationId, {
		seq: targetSeq,
		window,
		nowMs: input.nowMs,
		system: input.system,
	});
	return { ...moved, reason };
}

/**
 * Moves the cut after `seq` (a fixed-rule cut): the system part it stands on is the current
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
				input.system ?? conversationSystem(deps, tx, conversationId),
			),
			memoryDigest: memoryDigestOf(window, alwaysBudgetInTransaction(deps, tx)),
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
	const hasSummary = !!store.activeSummaryInTransaction?.(tx, conversationId);
	if (!newest || (cut && cut.seq >= newest.seq && !hasSummary)) return true;
	// The input states and compacted summaries saved for the earlier words go with them.
	store.dropStatesInTransaction(tx, conversationId);
	store.clearSummariesInTransaction?.(tx, conversationId);
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
	/** `## Memory` when no recent conversation follows it: the last message starts with it instead. */
	carry: string | null;
	carryInput?: ChatMessage;
	cut: ConversationCut | null;
	recent: Utterance[];
	/** When the newest utterance not waiting for an answer was said, behind the cut too (the gap `## State` names). */
	lastAt: number | null;
	/** When the recent conversation begins (its first utterance, else the cut): what came before is no record of it. */
	since: number | null;
	/** The memory items `## Memory` shows. */
	memoryItemIds: string[];
	/** The window the short references of `## Memory` belong to; null when memory gave no window. */
	refsKey: string | null;
	/** `## Memory` as this prefix shows it, when it shows any item (a routed turn's choice reads the same). */
	memory: string | null;
	/** Compacted `## Summary` section shown below `## Memory`, if an active valid summary exists. */
	summary?: string | null;
	/** Source provenance refs of the active `## Summary`, merged into forgetting checks. */
	summarySourceRefs?: string[];
	/** The user utterances from the window for argument extraction. */
	earlier: string[];
};

/**
 * The conversation's prefix as it stands (sections 3, 5 and 6): the same function draws it for a generation and for
 * the background calls on the conversation, so their prefix is byte for byte the next generation's while nothing
 * changes in between. It reads (the cut is placed by `placeCutInTransaction`), except for the short references a
 * generation hands out (`assignRefs`).
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
		requireProvenance?: boolean;
		traceInput?: boolean;
		/** The caller is a generation's prepare (a writer): the short references of `## Memory` are handed out now. */
		assignRefs?: boolean;
	},
): ConversationPrefix {
	const store = deps.conversation.input;
	const cut = store.cutInTransaction(tx, conversationId);
	const { history } = input.harness;
	// An utterance of the agent that copies the system part is not drawn: it was copied again turn after turn
	// (section 5.5 #1). The generation's gate keeps new ones out; this keeps out those kept before it, and the
	// agency's, which no generation gate checks.
	const copies = history.copyFilter ? systemCopyCheck(input.system) : null;
	const requireProvenance =
		input.requireProvenance ??
		deps.memory?.referenceInputs.afterForgettingInTransaction(tx) ??
		false;
	const utterances = store.utterancesAfterInTransaction(
		tx,
		conversationId,
		cut?.seq ?? 0,
	);
	// What an immediate forget holds back from the memory leaves the recent conversation before its closure delete.
	const withheld = excludedOnlyIn(
		deps,
		tx,
		utterances.flatMap((u) => (u.messageId ? [u.messageId] : [])),
	);
	const after = utterances.filter(
		(u) =>
			!(u.messageId && withheld.has(u.messageId)) &&
			!(copies && u.speaker === "agent" && copies(u.text)) &&
			inheritedHistorySources(
				deps,
				tx,
				conversationId,
				u,
				requireProvenance,
			) !== null,
	);
	const serves =
		deps.agency?.servesRepliesInTransaction?.(tx, conversationId) ?? false;
	const recent = recentUtterances(after, input.pending, history.users);
	const profile = currentProfileItems(
		deps,
		tx,
		conversationId,
		input.window?.profile.items ?? [],
	);
	const budget = alwaysBudgetInTransaction(deps, tx);
	const fitted = memoryLines(profile, budget);
	// The memory numbers the references on and never reuses them: a generation hands them out for what it shows (and
	// saves them), every other drawing of the same text reads them back.
	let refs: ReadonlyMap<string, string> | undefined;
	let refsKey: string | null = null;
	if (deps.memory && input.window) {
		refsKey = deps.memory.shortRefs.windowKeyOf(fitted.shown);
		refs = input.assignRefs
			? assignWindowRefs(deps.memory, tx, conversationId, refsKey, fitted.shown)
			: (readMemoryRefs(tx, conversationId, refsKey) ?? undefined);
	}
	const { lines, ids } = memoryLines(profile, budget, refs);
	// Always there before a recent conversation, so the conversation never opens with the agent's message.
	const memory = section(
		INPUT_HEADINGS.memory,
		lines.length ? lines : ["- なし"],
	);
	const imageNotes = new Map<string, string>();
	for (const utterance of recent) {
		if (!utterance.messageId) continue;
		const references = deps.conversation
			.imageReferencesInTransaction(tx, utterance.messageId)
			.filter(
				(ref) => !deps.memory?.isSourceRevokedInTransaction(tx, ref.messageId),
			);
		if (references.length)
			imageNotes.set(utterance.messageId, imageReferenceText(references));
	}
	const conversation = recentMessages(
		recent,
		imageNotes,
		input.harness.history.withCalls ?? serves,
		input.traceInput
			? (u) => ({
					kind: "history",
					at: u.at,
					id: u.messageId ?? undefined,
					...(u.messageId ? inputMessageRevision(deps, tx, u.messageId) : {}),
				})
			: undefined,
		serves,
	);
	const rawSummary =
		store.activeSummaryInTransaction?.(tx, conversationId) ?? null;
	const validSummary =
		rawSummary &&
		rawSummary.text.trim() &&
		summaryRefsValid(deps, tx, conversationId, rawSummary.sourceRefs)
			? rawSummary
			: null;
	const summarySection = validSummary
		? section(INPUT_HEADINGS.summary, [dataText(validSummary.text)])
		: null;
	const semiStatic = joinSections([memory, summarySection]);
	const messages: ChatMessage[] = [{ role: "system", content: input.system }];
	const memoryFrame: ChatMessage = { role: "user", content: semiStatic };
	if (input.traceInput) {
		markInput(messages[0]!, { kind: "system" });
		let from = INPUT_HEADINGS.memory.length + 1;
		for (const [index, line] of lines.entries()) {
			const item = profile.find((entry) => entry.id === ids[index]);
			markInput(
				memoryFrame,
				{
					kind: "memory",
					id: item?.id,
					revision: item ? String(item.revision) : undefined,
				},
				from,
				from + line.length,
			);
			from += line.length + 1;
		}
		if (!lines.length)
			markInput(memoryFrame, { kind: "memory" }, 0, (memory ?? "").length);
		if (summarySection && validSummary) {
			const start = semiStatic.indexOf(summarySection);
			if (start >= 0)
				markInput(
					memoryFrame,
					{ kind: "summary", id: validSummary.id },
					start,
					start + summarySection.length,
				);
		}
	}
	if (semiStatic && conversation.length) {
		// Keep Memory (+ Summary) separate from the opening history inside the same user message.
		if (conversation[0]!.role === "user") {
			const earlier = prependInput(conversation[0]!, {
				content: INPUT_HEADINGS.earlier,
			});
			conversation[0] = prependInput(earlier, memoryFrame);
		} else messages.push(memoryFrame);
	}
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
	const hasCarry =
		!conversation.length && (lines.length > 0 || !!summarySection);
	return {
		messages,
		carry: hasCarry ? semiStatic : null,
		...(input.traceInput && hasCarry ? { carryInput: memoryFrame } : {}),
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
		refsKey,
		memory: lines.length ? memory : null,
		summary: summarySection,
		summarySourceRefs: validSummary ? validSummary.sourceRefs : [],
		earlier: recent.filter((u) => u.speaker === "user").map((u) => u.text),
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
		const from = last.content.length + 2;
		last.content = `${last.content}\n\n${content}`;
		Object.assign(last, extra);
		if (prefix.carryInput) copyInputOrigins(last, prefix.carryInput, from);
		return messages;
	}
	const added: ChatMessage = { role: "user", content, ...extra };
	if (prefix.carryInput) copyInputOrigins(added, prefix.carryInput, 0);
	return [...messages, added];
}

export function inputMessageRevision(
	deps: DialogueDeps,
	db: Database,
	id: string,
) {
	const source = deps.conversation.sourceInTransaction(db, id);
	return source.state === "available" ? { revision: source.revision } : {};
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
	requireProvenance?: boolean,
): ConversationPrefix | null {
	let window: WindowSnapshot | null = null;
	try {
		window = deps.memory?.storedWindowInTransaction(tx, conversationId) ?? null;
	} catch {
		return null;
	}
	return conversationPrefixFrom(deps, tx, conversationId, {
		harness: backgroundHarness,
		system: conversationSystem(deps, tx, conversationId),
		window,
		pending: pendingMessageIdsInTransaction(deps, tx, conversationId),
		...(requireProvenance ? { requireProvenance } : {}),
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

/** A message of a background call: the prefix's words and its task (no image, no attachment). */
export type BackgroundMessage = Pick<ChatMessage, "role" | "content">;

/** A message as a background call sends it: what the conversation's own call sends of it, byte for byte. */
export const backgroundMessage = ({
	role,
	content,
}: ChatMessage): BackgroundMessage => ({ role, content });

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
	requireProvenance?: boolean,
): {
	messages: BackgroundMessage[];
	input?: import("../../memory").ReferenceInput;
} | null {
	const prefix = backgroundPrefixInTransaction(
		deps,
		tx,
		conversationId,
		requireProvenance,
	);
	if (!prefix) return null;
	const nowMs = Date.parse(deps.clock());
	const state = stateText(
		stateLinesInTransaction(deps, tx, {
			conversationId,
			nowMs,
			lastAt: prefix.lastAt,
			lastAgent:
				[...prefix.recent].reverse().find((u) => u.speaker === "agent") ?? null,
			state: deps.conversation.input.latestStateInTransaction(
				tx,
				conversationId,
			),
		}),
	);
	return {
		input: backgroundInput(deps, tx, conversationId, prefix),
		messages: taskMessages(prefix, [state, ...sections], task).map(
			backgroundMessage,
		),
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
			options?: { requireProvenance?: boolean },
		) =>
			backgroundTaskInTransaction(
				deps,
				db,
				conversationId,
				task,
				[],
				options?.requireProvenance,
			),
	};
}
