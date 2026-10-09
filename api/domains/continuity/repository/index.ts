import type { Database } from "bun:sqlite";
import type { ContinuityItem } from "../contracts";
export const migration = `
CREATE TABLE continuity_items (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('goal','decision','open_question')),
 text TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','resolved','retracted')),
 revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX continuity_items_conversation ON continuity_items(conversation_id, created_at, id);
CREATE TABLE continuity_revisions (conversation_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
`;
const columns =
	"id, conversation_id, kind, text, status, revision, created_at, updated_at";
function map(row: Record<string, unknown>): ContinuityItem {
	return {
		id: row.id as string,
		conversationId: row.conversation_id as string,
		kind: row.kind as ContinuityItem["kind"],
		text: row.text as string,
		status: row.status as ContinuityItem["status"],
		revision: row.revision as number,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
}
function bump(db: Database, conversationId: string) {
	db.query(
		"INSERT INTO continuity_revisions (conversation_id, revision) VALUES (?, 1) ON CONFLICT(conversation_id) DO UPDATE SET revision = revision + 1",
	).run(conversationId);
}
export function insertItem(db: Database, item: ContinuityItem) {
	db.query(
		`INSERT INTO continuity_items (${columns}) VALUES (?,?,?,?,?,?,?,?)`,
	).run(
		item.id,
		item.conversationId,
		item.kind,
		item.text,
		item.status,
		item.revision,
		item.createdAt,
		item.updatedAt,
	);
	bump(db, item.conversationId);
}
export function getItem(db: Database, id: string): ContinuityItem | null {
	const row = db
		.query(`SELECT ${columns} FROM continuity_items WHERE id = ?`)
		.get(id);
	return row ? map(row as Record<string, unknown>) : null;
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
export function listItems(
	db: Database,
	conversationId: string,
	activeOnly: boolean,
): ContinuityItem[] {
	return (
		db
			.query(
				`SELECT ${columns} FROM continuity_items WHERE conversation_id = ?${activeOnly ? " AND status='active'" : ""} ORDER BY rowid`,
			)
			.all(conversationId) as Record<string, unknown>[]
	).map(map);
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
