import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { headWithin } from "../../../infrastructure/context-budget";
import type {
	ConversationEvent,
	EventStore,
} from "../../../domains/continuity";
import {
	RESOURCE_LABEL_MAX,
	formatResourceUri,
	type ResourceAdapter,
	type ResourceRef,
	type ResourceView,
} from "../../../domains/resources";

export const EVENT_RESOURCE_KIND = "event";
const EVENT_ADAPTER_REF = "continuity.events";
const READ_TOKENS = 600;
const NOT_LABEL = new Set(["id", "at", "type", "by"]);

/** `<conversationId>:<eventId>`, e.g. `main:e174`. */
export const eventResourceId = (conversationId: string, seq: number) =>
	`${conversationId}:e${seq}`;

function parseId(id: string): { conversationId: string; seq: number } | null {
	const at = id.lastIndexOf(":");
	if (at < 1) return null;
	const match = /^e(\d{1,15})$/.exec(id.slice(at + 1));
	return match
		? { conversationId: id.slice(0, at), seq: Number(match[1]) }
		: null;
}

/** The first text field of the rendered line (after id, time, type and actor), else the type and actor. */
function labelOf(event: ConversationEvent, text: string): string {
	let line: string | null = null;
	try {
		const parsed = JSON.parse(text) as Record<string, unknown>;
		for (const [key, value] of Object.entries(parsed)) {
			if (NOT_LABEL.has(key) || typeof value !== "string") continue;
			const flat = value.replace(/\s+/g, " ").trim();
			if (flat) {
				line = flat;
				break;
			}
		}
	} catch {
		/* a line that is not JSON is labelled by its type */
	}
	return (line ?? `${event.type} ${event.by}`).slice(0, RESOURCE_LABEL_MAX);
}

/** The text of an event the model can still read: not moved out, not forgotten. */
const visibleText = (event: ConversationEvent | null) =>
	event && !event.forgotten && event.text !== null ? event.text : null;

/**
 * Conversation events (owner: continuity): read-only, found among the logged lines of the conversations.
 * Moved-out and forgotten events keep no text and are not found.
 */
export function createEventResourceAdapter(deps: {
	store: SqliteStore;
	events: Pick<EventStore, "eventInTransaction" | "logInTransaction">;
	conversationIds: (db: Database) => readonly string[];
}): ResourceAdapter {
	const refOf = (
		conversationId: string,
		event: ConversationEvent,
		text: string,
	): ResourceRef => ({
		uri: formatResourceUri(
			EVENT_RESOURCE_KIND,
			eventResourceId(conversationId, event.seq),
		),
		kind: EVENT_RESOURCE_KIND,
		label: labelOf(event, text),
		createdAt: event.at,
	});
	const lookup = (db: Database, id: string) => {
		const parsed = parseId(id);
		if (!parsed) return null;
		const event = deps.events.eventInTransaction(
			db,
			parsed.conversationId,
			parsed.seq,
		);
		const text = visibleText(event);
		return event && text !== null
			? { event, text, conversationId: parsed.conversationId }
			: null;
	};
	return {
		kind: EVENT_RESOURCE_KIND,
		fromResultInTransaction: () => [],
		getInTransaction(db, id): ResourceView | null {
			const found = lookup(db, id);
			if (!found) return null;
			const ref = refOf(found.conversationId, found.event, found.text);
			return {
				...ref,
				adapterRef: EVENT_ADAPTER_REF,
				targetRef: id,
				actions: ["read"],
				preview: ref.label,
			};
		},
		async search(query) {
			const text = query.text.trim().toLowerCase();
			const since = query.since ? Date.parse(query.since) : null;
			const until = query.until ? Date.parse(query.until) : null;
			const found = deps.store.read((db) =>
				deps.conversationIds(db).flatMap((conversationId) =>
					deps.events.logInTransaction(db, conversationId).flatMap((event) => {
						const line = visibleText(event);
						if (line === null) return [];
						const at = Date.parse(event.at);
						if (since !== null && at < since) return [];
						if (until !== null && at > until) return [];
						if (text && !line.toLowerCase().includes(text)) return [];
						return [{ at, ref: refOf(conversationId, event, line) }];
					}),
				),
			);
			return found
				.sort((a, b) => b.at - a.at)
				.slice(0, query.limit)
				.map(({ ref }) => ref);
		},
		async read(id) {
			const found = deps.store.read((db) => lookup(db, id));
			if (!found) throw new Error("item_not_found");
			return { text: headWithin(found.text, READ_TOKENS).text };
		},
	};
}
