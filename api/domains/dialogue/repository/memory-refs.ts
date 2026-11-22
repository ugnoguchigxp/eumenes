import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";

/**
 * The short references (`m1`...) the conversation's `## Memory` was drawn with: the memory hands them out (they are
 * numbered on and never reused), and the reads that draw the same text again (a background call on the conversation's
 * prefix) read them back here instead of handing them out. One row per conversation: the window they belong to and
 * the reference of each item shown.
 */
export const memoryRefsMigration: Migration = {
	id: "dialogue/0047-memory-refs",
	after: ["dialogue/0046-forget-hidden"],
	sql: `CREATE TABLE dialogue_memory_refs (
 conversation_id TEXT PRIMARY KEY, window_key TEXT NOT NULL, refs_json TEXT NOT NULL
);`,
};

export function saveMemoryRefs(
	db: Database,
	conversationId: string,
	windowKey: string,
	refs: ReadonlyMap<string, string>,
) {
	db.query(
		`INSERT INTO dialogue_memory_refs(conversation_id, window_key, refs_json) VALUES (?,?,?)
		 ON CONFLICT(conversation_id) DO UPDATE SET window_key = excluded.window_key, refs_json = excluded.refs_json`,
	).run(conversationId, windowKey, JSON.stringify([...refs]));
}

/** The references of the window `windowKey`; null when the conversation's saved ones are of another window. */
export function readMemoryRefs(
	db: Database,
	conversationId: string,
	windowKey: string,
): ReadonlyMap<string, string> | null {
	const row = db
		.query<{ window_key: string; refs_json: string }, [string]>(
			"SELECT window_key, refs_json FROM dialogue_memory_refs WHERE conversation_id = ?",
		)
		.get(conversationId);
	if (!row || row.window_key !== windowKey) return null;
	return new Map(JSON.parse(row.refs_json) as Array<[string, string]>);
}
