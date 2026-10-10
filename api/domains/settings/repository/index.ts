import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import { settingsSchema, type Settings } from "../contracts";
export const migration = `
CREATE TABLE settings_document (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL);
CREATE TABLE settings_credentials (id TEXT PRIMARY KEY, encrypted TEXT NOT NULL);
CREATE TABLE settings_requests (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL);
`;
export const epochsMigration = `CREATE TABLE settings_connection_epochs (id TEXT PRIMARY KEY,epoch INTEGER NOT NULL);`;
export function read(db: Database): Settings {
	const row = db
		.query("SELECT document FROM settings_document WHERE id=1")
		.get() as { document: string };
	return settingsSchema.parse(JSON.parse(row.document));
}
export function save(db: Database, value: Settings) {
	db.query(
		"INSERT INTO settings_document VALUES(1,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document",
	).run(JSON.stringify(value));
}

/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{ id: "settings/0001-init", sql: migration },
	{ id: "settings/0002-epochs", sql: epochsMigration },
];
