import type { Database } from "bun:sqlite";
import { hideMessages } from "../repository/forget-hidden";
import type { DialogueDeps } from "./context";

/**
 * What a forget takes out of the conversation's input: the forgotten utterances leave the recent conversation (the
 * cut moves at the next input when one was inside it), the summaries that stand on them or on a forgotten memory item
 * are retracted, and the states made from them are made again. Returns the conversations that changed.
 */
export function retractForgottenInput(
	deps: DialogueDeps,
	db: Database,
	input: { messageIds: readonly string[]; itemIds: readonly string[] },
): Set<string> {
	const store = deps.conversation.input;
	const changed = new Set(
		store.retractUtterancesInTransaction(db, input.messageIds, deps.clock()),
	);
	const summaryRefs = [
		...input.messageIds,
		...input.itemIds.map((itemId) => `memory:${itemId}`),
	];
	for (const conversationId of store.retractSummariesBySourceRefsInTransaction?.(
		db,
		summaryRefs,
		deps.clock(),
	) ?? [])
		changed.add(conversationId);
	return changed;
}

/**
 * The immediate stage of a forget (section 9.2): the messages the excluded records stand on leave the recent
 * conversation, its summaries and the history reads at once, as the closure delete will make them leave for good.
 * Each message is hidden in its own conversation (the one it was said in, whoever asked for the forget).
 */
export function hideExcludedInTransaction(
	deps: DialogueDeps,
	db: Database,
	input: { messageIds: readonly string[]; itemIds?: readonly string[] },
) {
	const itemIds = input.itemIds ?? [];
	if (input.messageIds.length === 0 && itemIds.length === 0) return;
	deps.contextInputs?.invalidate();
	const owners = new Map<string, string[]>();
	for (const messageId of input.messageIds) {
		const found = deps.conversation.messageInTransaction(db, messageId);
		if (!found) continue;
		const list = owners.get(found.message.conversationId) ?? [];
		list.push(messageId);
		owners.set(found.message.conversationId, list);
	}
	for (const [conversationId, messageIds] of owners)
		hideMessages(db, conversationId, messageIds, deps.clock());
	const changed = retractForgottenInput(deps, db, {
		messageIds: input.messageIds,
		itemIds,
	});
	// An excluded memory item may stand in the state's records, copied as it was.
	if (itemIds.length)
		for (const conversationId of owners.keys()) changed.add(conversationId);
	for (const conversationId of changed)
		deps.conversation.input.dropStatesInTransaction(db, conversationId);
}
