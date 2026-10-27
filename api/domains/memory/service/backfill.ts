import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import { jstSeconds } from "../../../infrastructure/jst-time";
import { estimateTextTokens } from "../../../infrastructure/context-budget";
import type { ConversationService } from "../../conversation";
import type { ContinuityService } from "../../continuity";
import {
	deleteRetiredConversation,
	dropRetiredLedger,
	hasRetiredLedger,
	retiredConversationIds,
	retiredExchanges,
	type RetiredExchange,
} from "../repository";

/** Exchanges that always come across, besides the kept and the unprocessed ones. */
const NEWEST = 2;
/** One event's share of the log's cap (section 8.3: a longer utterance keeps its head and a reference). */
const EVENT_SHARE = 0.1;

/** The head of a text within `limit` tokens. */
function head(text: string, limit: number): string {
	if (estimateTextTokens(text) <= limit) return text;
	const chars = [...text];
	let low = 0;
	let high = chars.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (estimateTextTokens(chars.slice(0, mid).join("")) <= limit) low = mid;
		else high = mid - 1;
	}
	return chars.slice(0, low).join("");
}

/** An ISO time as the JST seconds form every other event carries. */
function at(iso: string): string {
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? iso : jstSeconds(ms);
}

const log = getLogger("memory");

/**
 * The one-time move from the exchange ledger of the earlier design to the continuity event flow. For each
 * conversation that has retired exchanges and no event yet: the recent exchanges (the kept ones, the ones the steward
 * had not finished and the newest two), oldest first, become logged `said` events; those the steward had finished
 * count as handled, the unfinished ones stay for the new steward to learn from. The old summary is not carried over
 * (the conversation's input has no summaries). A handled conversation's retired rows are removed, and the retired
 * tables are dropped once none is left; a conversation that already has events is left alone with its rows (one
 * warning, no text), so its history is never lost.
 */
export function createBackfill(deps: {
	conversation: ConversationService;
	continuity: ContinuityService;
	/** The block ledger: exchanges that touch a blocked (forgotten, scheduled, specialist) message stay out. */
	blocked: (db: Database, messageIds: Iterable<string>) => Set<string>;
	/** The log's cap of the window plan: one event may take a tenth of it. */
	logCap: () => number;
}) {
	const { conversation, continuity } = deps;
	const events = continuity.events;

	function hasEvents(db: Database, conversationId: string): boolean {
		return (
			events.logInTransaction(db, conversationId).length > 0 ||
			events.pendingInTransaction(db, conversationId).length > 0
		);
	}

	function backfillConversation(db: Database, conversationId: string): number {
		const all = retiredExchanges(db, conversationId);
		const blocked = deps.blocked(
			db,
			all.flatMap((row) => [
				row.inputMessageId,
				...(row.answerMessageId ? [row.answerMessageId] : []),
			]),
		);
		const usable = all.filter(
			(row) =>
				!blocked.has(row.inputMessageId) &&
				(row.answerMessageId === null || !blocked.has(row.answerMessageId)),
		);
		const newest = new Set(
			usable.slice(-NEWEST).map((row) => row.inputMessageId),
		);
		const isRecent = (row: RetiredExchange) =>
			row.disposition === "keep" ||
			row.state === "pending" ||
			newest.has(row.inputMessageId);
		const recent = usable.filter(isRecent);
		const limit = Math.max(1, Math.floor(deps.logCap() * EVENT_SHARE));
		let appended = 0;
		const seqs: number[] = [];
		const say = (
			messageId: string,
			role: "user" | "assistant",
			handled: boolean,
		): boolean => {
			const found = conversation.messageInTransaction(db, messageId);
			if (!found || found.message.role !== role) return false;
			const text = head(found.message.text, limit);
			const cut = text.length < found.message.text.length;
			const { event } = events.appendInTransaction(db, {
				conversationId,
				at: at(found.message.createdAt),
				type: "said",
				by: role === "user" ? "user" : "agent",
				fields: {
					...(role === "assistant" ? { origin: "reply" } : {}),
					text,
					...(cut ? { textCut: true, ref: messageId } : {}),
				},
				messageIds: [messageId],
				dedupeKey: `backfill:${messageId}`,
			});
			if (handled) seqs.push(event.seq);
			appended++;
			return true;
		};
		for (const row of recent) {
			const handled = row.state === "done";
			if (!say(row.inputMessageId, "user", handled)) continue;
			if (row.answerMessageId) say(row.answerMessageId, "assistant", handled);
		}
		if (seqs.length > 0)
			events.markCuratedInTransaction(db, conversationId, seqs);
		return appended;
	}

	return {
		/** Runs once; returns how many events were written. A no-op when the retired tables are gone. */
		backfillInTransaction(db: Database): {
			conversations: number;
			events: number;
		} {
			if (!hasRetiredLedger(db)) return { conversations: 0, events: 0 };
			let conversations = 0;
			let written = 0;
			let skipped = 0;
			for (const conversationId of retiredConversationIds(db)) {
				if (hasEvents(db, conversationId)) {
					skipped++;
					continue;
				}
				written += backfillConversation(db, conversationId);
				deleteRetiredConversation(db, conversationId);
				conversations++;
			}
			if (skipped > 0)
				log.warn("memory.ledger_backfill_skipped", { count: skipped });
			else dropRetiredLedger(db);
			return { conversations, events: written };
		},
		/**
		 * The backfill as one step of recovery: it must not make memory unhealthy. A failure keeps the retired
		 * tables and the next start tries again.
		 */
		runInTransaction(db: Database) {
			db.exec("SAVEPOINT memory_backfill");
			try {
				const done = this.backfillInTransaction(db);
				db.exec("RELEASE memory_backfill");
				if (done.conversations > 0)
					log.info("memory.ledger_backfilled", { count: done.events });
			} catch (error) {
				db.exec("ROLLBACK TO memory_backfill");
				db.exec("RELEASE memory_backfill");
				log.warn(
					"memory.ledger_backfill_failed",
					{ reason: "backfill_failed" },
					error,
				);
			}
		},
	};
}
