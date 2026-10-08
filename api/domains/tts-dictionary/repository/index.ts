import type { Database } from "bun:sqlite";
import type { Entry } from "../contracts";
export const migration = `
CREATE TABLE tts_dictionary (written TEXT PRIMARY KEY, spoken TEXT NOT NULL, updated_at INTEGER NOT NULL);
`;
export function list(db: Database): Entry[] {
	return db
		.query("SELECT written,spoken FROM tts_dictionary ORDER BY written")
		.all() as Entry[];
}
export function lookup(db: Database, written: string): string | null {
	const row = db
		.query("SELECT spoken FROM tts_dictionary WHERE written=?")
		.get(written) as { spoken: string } | null;
	return row?.spoken ?? null;
}
export function upsert(db: Database, entry: Entry, now: number) {
	db.query(
		"INSERT INTO tts_dictionary(written,spoken,updated_at) VALUES(?,?,?) ON CONFLICT(written) DO UPDATE SET spoken=excluded.spoken,updated_at=excluded.updated_at",
	).run(entry.written, entry.spoken, now);
}
export function remove(db: Database, written: string) {
	db.query("DELETE FROM tts_dictionary WHERE written=?").run(written);
}
