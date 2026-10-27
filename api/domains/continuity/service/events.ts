import type { Database } from "bun:sqlite";
import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { referenceJson } from "../../../infrastructure/reference-json";
import type { ConversationEvent, EventInput } from "../contracts/events";
import {
	conversationsWithUncurated,
	eventByDedupe,
	eventByDeliveryKey,
	eventBySeq,
	eventsOfMessages,
	eventsWithStatus,
	eventTexts,
	forgetEvent,
	insertEvent,
	latestEventMs,
	latestSeq,
	logEvent,
	loggedAfter,
	reopenEvent,
	reviseEvent,
	markCurated,
	nextLogOrder,
	nextSeq,
	uncuratedEvents,
} from "../repository/events";

/** The text of an event as the model reads it: id, time, type and actor first, then its own fields. */
function render(
	seq: number,
	input: Pick<EventInput, "at" | "type" | "by">,
	fields: Record<string, unknown>,
): string {
	return referenceJson({
		id: `e${seq}`,
		at: input.at,
		type: input.type,
		by: input.by,
		...fields,
	});
}

/** What forgetting leaves of an event: that it existed, never what it said. */
function forgottenText(event: ConversationEvent): string {
	return referenceJson({
		id: event.id,
		at: event.at,
		type: event.type,
		by: event.by,
		forgotten: true,
	});
}

/**
 * The event flow of the active short-term memory: what was said, delivered, done and noticed. Every function runs
 * inside the caller's write (or read) transaction; the store never opens one of its own.
 */
export function createEventStore() {
	return {
		/**
		 * Numbers, renders and freezes one event. A pending user utterance waits outside the log; any other event
		 * is appended to the log at once. A repeated `dedupeKey` returns the first event and adds nothing.
		 */
		appendInTransaction(
			db: Database,
			input: EventInput,
		): { event: ConversationEvent; created: boolean } {
			if (input.dedupeKey) {
				const existing = eventByDedupe(
					db,
					input.conversationId,
					input.dedupeKey,
				);
				if (existing) return { event: existing, created: false };
			}
			if (input.pending && !(input.type === "said" && input.by === "user"))
				throw new Error("invalid_pending_event");
			const seq = nextSeq(db, input.conversationId);
			const fullText = render(seq, input, input.fields);
			insertEvent(db, {
				conversationId: input.conversationId,
				seq,
				at: input.at,
				type: input.type,
				by: input.by,
				status: input.pending ? "pending" : "logged",
				logOrder: input.pending ? null : nextLogOrder(db, input.conversationId),
				fullText,
				fullTokens: estimateTextTokens(fullText),
				shortText: null,
				shortTokens: null,
				dedupeKey: input.dedupeKey ?? null,
				deliveryKey: input.deliveryKey ?? null,
				messageIds: input.messageIds ?? [],
			});
			return {
				event: eventBySeq(db, input.conversationId, seq)!,
				created: true,
			};
		},
		/**
		 * Marks pending utterances handled: each is appended to the log now, in receipt order, after whatever the
		 * log already holds (the log is in appending order; `at` keeps the real time). Already handled ones stay.
		 */
		handleInTransaction(
			db: Database,
			conversationId: string,
			seqs: readonly number[],
		): ConversationEvent[] {
			const handled: ConversationEvent[] = [];
			for (const seq of [...seqs].sort((a, b) => a - b)) {
				if (logEvent(db, conversationId, seq, nextLogOrder(db, conversationId)))
					handled.push(eventBySeq(db, conversationId, seq)!);
			}
			return handled;
		},
		/**
		 * An utterance a specialist gave back (the ContextWindow specification, section 6.8) is the main agent's
		 * unhandled one again: pending, with the fields it is shown with now. False when it was not logged.
		 */
		reopenInTransaction(
			db: Database,
			conversationId: string,
			seq: number,
			fields: Record<string, unknown>,
		): boolean {
			const event = eventBySeq(db, conversationId, seq);
			if (!event) return false;
			const text = render(seq, event, fields);
			return reopenEvent(
				db,
				conversationId,
				seq,
				text,
				estimateTextTokens(text),
			);
		},
		pendingInTransaction: (db: Database, conversationId: string) =>
			eventsWithStatus(db, conversationId, "pending"),
		/** The time (ms) of the newest logged or pending event; null when there is none. */
		latestMsInTransaction: latestEventMs,
		logInTransaction: (db: Database, conversationId: string) =>
			eventsWithStatus(db, conversationId, "logged"),
		/** The logged events after `seq`: what a generation added since it was prepared. */
		loggedAfterInTransaction: loggedAfter,
		/** The newest event seq of the conversation (0 when none). */
		latestSeqInTransaction: latestSeq,
		/** How much of an utterance reached the user (its `delivered` event); null while none was recorded. */
		heardInTransaction(
			db: Database,
			conversationId: string,
			saidId: string,
		): "full" | "partial" | "none" | null {
			const event = eventByDedupe(db, conversationId, `delivered:${saidId}`);
			if (!event?.text) return null;
			const heard = (JSON.parse(event.text) as { heard?: unknown }).heard;
			return heard === "full" || heard === "partial" ? heard : "none";
		},
		eventInTransaction: (db: Database, conversationId: string, seq: number) =>
			eventBySeq(db, conversationId, seq),
		/** Every event that carries the message, whatever its status. */
		ofMessageInTransaction: (db: Database, messageId: string) =>
			eventsOfMessages(db, [messageId]).flatMap(
				({ conversationId, seq }) => eventBySeq(db, conversationId, seq) ?? [],
			),
		/** The utterance a delivery reports on (see `EventInput.deliveryKey`). */
		deliveredUtteranceInTransaction: eventByDeliveryKey,
		/**
		 * Forgetting messages reaches the short-term memory: every event that showed one keeps only that it existed.
		 * Returns the conversations that changed.
		 */
		forgetMessagesInTransaction(
			db: Database,
			messageIds: readonly string[],
			_at: string,
		): string[] {
			const changed = new Set<string>();
			for (const { conversationId, seq } of eventsOfMessages(db, messageIds)) {
				const event = eventBySeq(db, conversationId, seq);
				if (!event || event.forgotten) continue;
				const text = forgottenText(event);
				forgetEvent(db, conversationId, seq, text, estimateTextTokens(text));
				changed.add(conversationId);
			}
			return [...changed];
		},
		/**
		 * A corrected message reaches the short-term memory: every `said` event that showed it now says `text`.
		 * Returns the conversations that changed.
		 */
		correctMessageInTransaction(
			db: Database,
			messageId: string,
			text: string,
			_at: string,
		): string[] {
			const changed = new Set<string>();
			const revised = (stored: string | null) => {
				if (stored === null) return null;
				const {
					id: _id,
					at: when,
					type,
					by,
					...fields
				} = JSON.parse(stored) as Record<string, unknown>;
				if (typeof fields.text !== "string") return null;
				const next = referenceJson({
					id: _id,
					at: when,
					type,
					by,
					...fields,
					text,
				});
				return { text: next, tokens: estimateTextTokens(next) };
			};
			for (const { conversationId, seq } of eventsOfMessages(db, [messageId])) {
				const event = eventBySeq(db, conversationId, seq);
				if (!event || event.forgotten || event.type !== "said") continue;
				const stored = eventTexts(db, conversationId, seq);
				const full = revised(stored?.full ?? null);
				const short = revised(stored?.short ?? null);
				if (!full && !short) continue;
				reviseEvent(db, conversationId, seq, full, short);
				changed.add(conversationId);
			}
			return [...changed];
		},
		uncuratedInTransaction: uncuratedEvents,
		conversationsWithUncuratedInTransaction: conversationsWithUncurated,
		markCuratedInTransaction: markCurated,
	};
}
export type EventStore = ReturnType<typeof createEventStore>;
