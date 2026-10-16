import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
export const migrations: readonly Migration[] = [
	{
		id: "google-accounts/0001-init",
		after: ["settings/0001-init"],
		sql: `
 CREATE TABLE google_account_connection (
 id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, sealed TEXT
 );
 INSERT INTO google_account_connection(id,revision,sealed) VALUES(1,0,NULL);`,
	},
];
export function read(db: Database): {
	revision: number;
	sealed: string | null;
} {
	return db
		.query("SELECT revision,sealed FROM google_account_connection WHERE id=1")
		.get() as { revision: number; sealed: string | null };
}
export function save(db: Database, revision: number, sealed: string) {
	db.query(
		"UPDATE google_account_connection SET revision=?,sealed=? WHERE id=1",
	).run(revision + 1, sealed);
}
