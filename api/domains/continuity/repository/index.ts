import type { Database } from "bun:sqlite";
import type { Bookmark, BookmarkEvent } from "../contracts";

export const migration = `
CREATE TABLE continuity_events (
	sequence INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	bookmark_id TEXT NOT NULL,
	conversation_id TEXT NOT NULL,
	operation TEXT NOT NULL CHECK(operation IN ('create','revise','deactivate')),
	kind TEXT NOT NULL CHECK(kind IN ('goal','decision','open_question')),
	text TEXT NOT NULL,
	status TEXT NOT NULL CHECK(status IN ('active','inactive')),
	revision INTEGER NOT NULL CHECK(revision >= 1),
	source_message_id TEXT NOT NULL,
	source_digest TEXT NOT NULL,
	origin TEXT NOT NULL CHECK(origin IN ('user_confirmed','user_edited')),
	request_id TEXT NOT NULL,
	request_digest TEXT NOT NULL,
	created_at TEXT NOT NULL,
	UNIQUE(bookmark_id, revision),
	UNIQUE(conversation_id, request_id)
);
CREATE INDEX continuity_events_conversation ON continuity_events(conversation_id, sequence);
CREATE INDEX continuity_events_bookmark ON continuity_events(bookmark_id, sequence);
`;

export interface EventInsert {
	id: string;
	bookmarkId: string;
	conversationId: string;
	operation: BookmarkEvent["operation"];
	kind: BookmarkEvent["kind"];
	text: string;
	status: BookmarkEvent["status"];
	revision: number;
	sourceMessageId: string;
	sourceDigest: string;
	origin: BookmarkEvent["origin"];
	requestId: string;
	requestDigest: string;
	createdAt: string;
}

/** An event plus the creation time of its bookmark (from revision 1). */
export interface StoredEvent extends BookmarkEvent {
	requestDigest: string;
	bookmarkCreatedAt: string;
}

interface EventRow {
	sequence: number;
	id: string;
	bookmark_id: string;
	conversation_id: string;
	operation: BookmarkEvent["operation"];
	kind: BookmarkEvent["kind"];
	text: string;
	status: BookmarkEvent["status"];
	revision: number;
	source_message_id: string;
	source_digest: string;
	origin: BookmarkEvent["origin"];
	request_id: string;
	request_digest: string;
	created_at: string;
	bookmark_created_at: string;
}

const SELECT_EVENT = `
SELECT e.sequence, e.id, e.bookmark_id, e.conversation_id, e.operation, e.kind, e.text,
	e.status, e.revision, e.source_message_id, e.source_digest, e.origin, e.request_id,
	e.request_digest, e.created_at, c.created_at AS bookmark_created_at, c.sequence AS creation_sequence
FROM continuity_events e
JOIN continuity_events c ON c.bookmark_id = e.bookmark_id AND c.revision = 1`;

function toEvent(row: EventRow): StoredEvent {
	return {
		sequence: row.sequence,
		id: row.id,
		bookmarkId: row.bookmark_id,
		conversationId: row.conversation_id,
		operation: row.operation,
		kind: row.kind,
		text: row.text,
		status: row.status,
		revision: row.revision,
		sourceMessageId: row.source_message_id,
		sourceDigest: row.source_digest,
		origin: row.origin,
		requestId: row.request_id,
		requestDigest: row.request_digest,
		createdAt: row.created_at,
		bookmarkCreatedAt: row.bookmark_created_at,
	};
}

/** Current value of a bookmark as of the given event. */
export function toBookmark(event: StoredEvent): Bookmark {
	return {
		id: event.bookmarkId,
		conversationId: event.conversationId,
		kind: event.kind,
		text: event.text,
		status: event.status,
		revision: event.revision,
		origin: event.origin,
		sourceMessageId: event.sourceMessageId,
		sourceDigest: event.sourceDigest,
		createdAt: event.bookmarkCreatedAt,
		updatedAt: event.createdAt,
	};
}

/** Public event shape (drops internal columns). */
export function toPublicEvent(event: StoredEvent): BookmarkEvent {
	const {
		requestDigest: _digest,
		bookmarkCreatedAt: _created,
		...rest
	} = event;
	return rest;
}

export function insertEvent(db: Database, event: EventInsert): void {
	db.query(
		`INSERT INTO continuity_events (id, bookmark_id, conversation_id, operation, kind, text, status, revision,
			source_message_id, source_digest, origin, request_id, request_digest, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		event.id,
		event.bookmarkId,
		event.conversationId,
		event.operation,
		event.kind,
		event.text,
		event.status,
		event.revision,
		event.sourceMessageId,
		event.sourceDigest,
		event.origin,
		event.requestId,
		event.requestDigest,
		event.createdAt,
	);
}

export function eventByRequest(
	db: Database,
	conversationId: string,
	requestId: string,
): StoredEvent | null {
	const row = db
		.query(`${SELECT_EVENT} WHERE e.conversation_id = ? AND e.request_id = ?`)
		.get(conversationId, requestId) as EventRow | null;
	return row ? toEvent(row) : null;
}

export function latestEvent(
	db: Database,
	conversationId: string,
	bookmarkId: string,
): StoredEvent | null {
	const row = db
		.query(
			`${SELECT_EVENT} WHERE e.conversation_id = ? AND e.bookmark_id = ? ORDER BY e.revision DESC LIMIT 1`,
		)
		.get(conversationId, bookmarkId) as EventRow | null;
	return row ? toEvent(row) : null;
}

export function listBookmarks(
	db: Database,
	conversationId: string,
	includeInactive: boolean,
): Bookmark[] {
	const rows = db
		.query(
			`${SELECT_EVENT}
			WHERE e.conversation_id = ?
				AND e.revision = (SELECT MAX(revision) FROM continuity_events WHERE bookmark_id = e.bookmark_id)
				${includeInactive ? "" : "AND e.status = 'active'"}
			ORDER BY creation_sequence`,
		)
		.all(conversationId) as EventRow[];
	return rows.map((row) => toBookmark(toEvent(row)));
}

export function countActive(db: Database, conversationId: string): number {
	return (
		db
			.query(
				`SELECT COUNT(*) AS n FROM continuity_events e
				WHERE e.conversation_id = ? AND e.status = 'active'
					AND e.revision = (SELECT MAX(revision) FROM continuity_events WHERE bookmark_id = e.bookmark_id)`,
			)
			.get(conversationId) as { n: number }
	).n;
}

export function stateRevision(db: Database, conversationId: string): number {
	return (
		(
			db
				.query(
					"SELECT MAX(sequence) AS s FROM continuity_events WHERE conversation_id = ?",
				)
				.get(conversationId) as { s: number | null }
		).s ?? 0
	);
}

export function listHistory(
	db: Database,
	conversationId: string,
	bookmarkId: string,
	after: number,
	limit: number,
): StoredEvent[] {
	const rows = db
		.query(
			`${SELECT_EVENT} WHERE e.conversation_id = ? AND e.bookmark_id = ? AND e.sequence > ?
			ORDER BY e.sequence LIMIT ?`,
		)
		.all(conversationId, bookmarkId, after, limit) as EventRow[];
	return rows.map(toEvent);
}
