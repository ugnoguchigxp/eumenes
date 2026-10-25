import type { ConversationEvent } from "../../../continuity";
import { decisionsOfMessages } from "../../repository";
import { type LabelTable, type LoadedEvent, isRecord } from "../context";
import type { ApplyResult, StepEnv } from "../types";

/**
 * The handled events the memory reflection still has to read, oldest first. Events that carry nothing to learn
 * from (a delivery, an action, a notice, a specialist session's words, a forgotten event, a message of the block
 * ledger) are marked handled here: they are never offered. A forgotten event shows only that it existed.
 */
export function pendingEvents(env: StepEnv): ConversationEvent[] {
	const { db, deps, conversationId } = env;
	const uncurated = deps.continuity.events.uncuratedInTransaction(
		db,
		conversationId,
	);
	if (uncurated.length === 0) return [];
	const blocked = deps.memory.blockedMessageIdsInTransaction(
		db,
		uncurated.flatMap((event) => event.messageIds),
	);
	const skip: number[] = [];
	const todo: ConversationEvent[] = [];
	for (const event of uncurated) {
		if (
			event.type !== "said" ||
			event.by === "host" ||
			event.by === "specialist" ||
			event.forgotten ||
			event.messageIds.some((id) => blocked.has(id))
		)
			skip.push(event.seq);
		else todo.push(event);
	}
	if (skip.length > 0)
		deps.continuity.events.markCuratedInTransaction(db, conversationId, skip);
	return todo;
}

/**
 * The label the model reads for a loaded event: the conversation's own event id (`e<seq>`, the id the
 * conversation's log shows), or `x<n>` for a message shown as context that no event stands for.
 */
export function eventLabel(event: LoadedEvent, index: number): string {
	return event.seq === null ? `x${index + 1}` : `e${event.seq}`;
}

/** What the curate step saved from these messages (the steps after it read it as context). */
export function curatedOf(
	env: StepEnv,
	messageIds: readonly string[],
): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	for (const decision of decisionsOfMessages(
		env.db,
		env.conversationId,
		"curate-memory",
		messageIds,
		3,
	)) {
		const output = decision.output;
		if (!isRecord(output)) continue;
		for (const section of ["remember", "update"] as const) {
			const list = output[section];
			if (!Array.isArray(list)) continue;
			for (const entry of list)
				if (isRecord(entry) && typeof entry.text === "string")
					out.push({
						kind: typeof entry.kind === "string" ? entry.kind : "update",
						text: entry.text,
					});
		}
	}
	return out.slice(0, 12);
}

/** The messages a label table stands on. */
export function allMessageIds(table: LabelTable): string[] {
	return Object.values(table)
		.map((entry) => entry.messageId)
		.filter((id): id is string => id !== null);
}

/** Decision references to messages (a forget of any of them finds the decision). */
export function messageRefs(ids: Iterable<string>): ApplyResult["refs"] {
	return [...new Set(ids)].map((id) => ({ type: "message" as const, id }));
}
