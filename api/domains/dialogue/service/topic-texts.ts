import type { Database } from "bun:sqlite";
import type { ConversationService } from "../../conversation";
import type { Run } from "../contracts";
import { recentPriorRuns } from "../repository";
import { clipHistoryText } from "./context-compiler";

/**
 * The wording the World Broker looks for known targets in: this turn's input first, then the previous
 * exchange (its input and, when it completed, its answer). Messages the memory ledger blocked (forgotten or
 * excluded) are never offered. Each text is cut like the history shows it.
 */
export function topicTexts(
	tx: Database,
	run: Run,
	conversation: ConversationService,
	blocked: ReadonlySet<string>,
): string[] {
	const ids = [run.inputMessageId];
	const previous = recentPriorRuns(tx, run, 1)[0];
	if (previous) {
		ids.push(previous.inputMessageId);
		if (previous.status === "completed" && previous.answerMessageId !== null)
			ids.push(previous.answerMessageId);
	}
	const texts: string[] = [];
	for (const id of ids) {
		if (blocked.has(id)) continue;
		const message = conversation.messageInTransaction(tx, id);
		if (message) texts.push(clipHistoryText(message.message.text));
	}
	return texts;
}
