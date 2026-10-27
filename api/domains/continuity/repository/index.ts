import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { ContinuityItem } from "../contracts";
import {
	dropActiveMigration,
	dropWindowMigration,
	eventsMigration,
	retractActivityMigration,
} from "./events";
export const migration = `
CREATE TABLE continuity_items (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('goal','decision','open_question')),
 text TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','resolved','retracted')),
 revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX continuity_items_conversation ON continuity_items(conversation_id, created_at, id);
CREATE TABLE continuity_revisions (conversation_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
`;
/**
 * Short-term layer: activity and memo kinds, where an item came from, and when it stops mattering.
 * SQLite cannot change a CHECK, so the table is rebuilt (rows keep their ids and positions).
 */
export const shortTermMigration = `
CREATE TABLE continuity_items_v2 (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('goal','decision','open_question','activity','memo')),
 text TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','resolved','retracted')),
 revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 origin TEXT NOT NULL DEFAULT 'user' CHECK(origin IN ('user','agent')),
 source_message_id TEXT, expires_at TEXT
);
INSERT INTO continuity_items_v2 (id, conversation_id, kind, text, status, revision, created_at, updated_at)
 SELECT id, conversation_id, kind, text, status, revision, created_at, updated_at FROM continuity_items ORDER BY rowid;
DROP TABLE continuity_items;
ALTER TABLE continuity_items_v2 RENAME TO continuity_items;
CREATE INDEX continuity_items_conversation ON continuity_items(conversation_id, created_at, id);
`;
/**
 * A note comes from one or more messages. The sources live in their own table (many to many) and the old
 * single `source_message_id` column goes: existing values are copied over first.
 */
export const itemSourceMigration = `
CREATE TABLE continuity_item_source (
 item_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY (item_id, message_id)
);
CREATE INDEX continuity_item_source_message ON continuity_item_source(message_id);
INSERT INTO continuity_item_source (item_id, message_id)
 SELECT id, source_message_id FROM continuity_items WHERE source_message_id IS NOT NULL;
ALTER TABLE continuity_items DROP COLUMN source_message_id;
`;
const columns =
	"id, conversation_id, kind, text, status, revision, created_at, updated_at, origin, expires_at";
function map(
	row: Record<string, unknown>,
	sources: ReadonlyMap<string, string[]>,
): ContinuityItem {
	return {
		id: row.id as string,
		conversationId: row.conversation_id as string,
		kind: row.kind as ContinuityItem["kind"],
		text: row.text as string,
		status: row.status as ContinuityItem["status"],
		revision: row.revision as number,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
		origin: row.origin as ContinuityItem["origin"],
		sourceMessageIds: sources.get(row.id as string) ?? [],
		expiresAt: (row.expires_at as string | null) ?? null,
	};
}
function bump(db: Database, conversationId: string) {
	db.query(
		"INSERT INTO continuity_revisions (conversation_id, revision) VALUES (?, 1) ON CONFLICT(conversation_id) DO UPDATE SET revision = revision + 1",
	).run(conversationId);
}
/** Ids bound per statement: far below SQLite's variable limit. */
const SOURCE_CHUNK = 500;
/** The source messages of the given items, in the order they were added. */
function sourcesOf(
	db: Database,
	ids: readonly string[],
): Map<string, string[]> {
	const found = new Map<string, string[]>();
	for (let start = 0; start < ids.length; start += SOURCE_CHUNK) {
		const chunk = ids.slice(start, start + SOURCE_CHUNK);
		const marks = chunk.map(() => "?").join(",");
		const rows = db
			.query(
				`SELECT item_id AS itemId, message_id AS messageId FROM continuity_item_source WHERE item_id IN (${marks}) ORDER BY rowid`,
			)
			.all(...chunk) as Array<{ itemId: string; messageId: string }>;
		for (const row of rows)
			found.set(row.itemId, [...(found.get(row.itemId) ?? []), row.messageId]);
	}
	return found;
}
/** Adds source messages to an item (already present ones are kept as they are). */
export function addSources(
	db: Database,
	itemId: string,
	messageIds: readonly string[],
) {
	const insert = db.query(
		"INSERT OR IGNORE INTO continuity_item_source (item_id, message_id) VALUES (?,?)",
	);
	for (const messageId of messageIds) insert.run(itemId, messageId);
}
export function insertItem(db: Database, item: ContinuityItem) {
	db.query(
		`INSERT INTO continuity_items (${columns}) VALUES (?,?,?,?,?,?,?,?,?,?)`,
	).run(
		item.id,
		item.conversationId,
		item.kind,
		item.text,
		item.status,
		item.revision,
		item.createdAt,
		item.updatedAt,
		item.origin,
		item.expiresAt,
	);
	addSources(db, item.id, item.sourceMessageIds);
	bump(db, item.conversationId);
}
/** Rewrites the text and/or expiry of an active item at its expected revision; false when it moved on. */
export function updateItem(
	db: Database,
	id: string,
	expectedRevision: number,
	change: { text?: string; expiresAt?: string | null },
	now: string,
): boolean {
	const sets = ["revision=revision+1", "updated_at=?"];
	const values: Array<string | number | null> = [now];
	if (change.text !== undefined) {
		sets.push("text=?");
		values.push(change.text);
	}
	if (change.expiresAt !== undefined) {
		sets.push("expires_at=?");
		values.push(change.expiresAt);
	}
	const result = db
		.query(
			`UPDATE continuity_items SET ${sets.join(", ")} WHERE id=? AND revision=? AND status='active'`,
		)
		.run(...values, id, expectedRevision);
	if (result.changes !== 1) return false;
	const item = getItem(db, id);
	if (item) bump(db, item.conversationId);
	return true;
}
export function getItem(db: Database, id: string): ContinuityItem | null {
	const row = db
		.query(`SELECT ${columns} FROM continuity_items WHERE id = ?`)
		.get(id);
	return row ? map(row as Record<string, unknown>, sourcesOf(db, [id])) : null;
}
export function transitionItem(
	db: Database,
	id: string,
	expectedRevision: number,
	status: "resolved" | "retracted",
	now: string,
): boolean {
	const result = db
		.query(
			"UPDATE continuity_items SET status=?, revision=revision+1, updated_at=? WHERE id=? AND revision=? AND status='active'",
		)
		.run(status, now, id, expectedRevision);
	if (result.changes !== 1) return false;
	const item = getItem(db, id);
	if (item) bump(db, item.conversationId);
	return true;
}
/**
 * Physically deletes every note that came from any of the messages (one source in the set is enough) and returns
 * their ids. A forgotten message must
 * not live on in a note, not even as a retracted row. The conversations' revisions move (they hold no text).
 */
export function deleteBySource(
	db: Database,
	messageIds: readonly string[],
): { noteIds: string[]; deleted: number } {
	const unique = [...new Set(messageIds)];
	const noteIds: string[] = [];
	for (let start = 0; start < unique.length; start += SOURCE_CHUNK) {
		const chunk = unique.slice(start, start + SOURCE_CHUNK);
		const marks = chunk.map(() => "?").join(",");
		const rows = db
			.query(
				`SELECT DISTINCT i.id AS id, i.conversation_id AS conversationId FROM continuity_items i
				 JOIN continuity_item_source s ON s.item_id = i.id WHERE s.message_id IN (${marks})`,
			)
			.all(...chunk) as Array<{ id: string; conversationId: string }>;
		const remove = db.query("DELETE FROM continuity_items WHERE id = ?");
		const removeSources = db.query(
			"DELETE FROM continuity_item_source WHERE item_id = ?",
		);
		for (const row of rows) {
			remove.run(row.id);
			removeSources.run(row.id);
			noteIds.push(row.id);
			bump(db, row.conversationId);
		}
	}
	return { noteIds, deleted: noteIds.length };
}
export function listItems(
	db: Database,
	conversationId: string,
	activeOnly: boolean,
): ContinuityItem[] {
	const rows = db
		.query(
			`SELECT ${columns} FROM continuity_items WHERE conversation_id = ?${activeOnly ? " AND status='active'" : ""} ORDER BY rowid`,
		)
		.all(conversationId) as Record<string, unknown>[];
	const sources = sourcesOf(
		db,
		rows.map((row) => row.id as string),
	);
	return rows.map((row) => map(row, sources));
}
export function conversationRevision(
	db: Database,
	conversationId: string,
): number {
	return (
		(
			db
				.query(
					"SELECT revision FROM continuity_revisions WHERE conversation_id = ?",
				)
				.get(conversationId) as { revision: number } | null
		)?.revision ?? 0
	);
}

/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{ id: "continuity/0001-init", sql: migration },
	{
		id: "continuity/0002-short-term",
		sql: shortTermMigration,
		after: ["continuity/0001-init"],
	},
	{
		id: "continuity/0003-item-source",
		sql: itemSourceMigration,
		after: ["continuity/0002-short-term"],
	},
	{
		id: "continuity/0004-events",
		sql: eventsMigration,
		after: ["continuity/0003-item-source"],
	},
	{
		id: "continuity/0005-drop-active",
		sql: dropActiveMigration,
		after: ["continuity/0004-events"],
	},
	{
		id: "continuity/0006-retract-activity",
		sql: retractActivityMigration,
		after: ["continuity/0005-drop-active"],
	},
	{
		id: "continuity/0007-drop-window",
		sql: dropWindowMigration,
		after: ["continuity/0006-retract-activity"],
	},
];
