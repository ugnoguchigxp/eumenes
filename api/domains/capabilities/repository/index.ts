import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { Definition, FixedDefinition } from "../contracts";
export const migration = `
CREATE TABLE capability_items (key TEXT PRIMARY KEY,id TEXT NOT NULL,kind TEXT NOT NULL,active_revision_id TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,generation INTEGER NOT NULL DEFAULT 0,UNIQUE(kind,id));
CREATE TABLE capability_revisions (id TEXT PRIMARY KEY,item_key TEXT NOT NULL,revision INTEGER NOT NULL,definition_json TEXT NOT NULL,definition_hash TEXT NOT NULL,created_at_ms INTEGER NOT NULL,UNIQUE(item_key,revision));
CREATE TABLE capability_dependencies (revision_id TEXT NOT NULL,dependency_revision_id TEXT NOT NULL,PRIMARY KEY(revision_id,dependency_revision_id));
CREATE VIRTUAL TABLE capability_search USING fts5(key UNINDEXED,content,tokenize='trigram');
`;
/** Appended migration: never fold into the first one. */
export const learnedMigration = `
ALTER TABLE capability_items ADD COLUMN discovery_mode TEXT NOT NULL DEFAULT 'catalog';
ALTER TABLE capability_items ADD COLUMN origin TEXT NOT NULL DEFAULT 'builtin';
CREATE INDEX capability_items_origin ON capability_items(origin,kind);
`;
export function get(db: Database, revisionId: string): FixedDefinition | null {
	const row = db
		.query(
			"SELECT r.*,i.enabled,i.generation FROM capability_revisions r JOIN capability_items i ON i.key=r.item_key WHERE r.id=?",
		)
		.get(revisionId) as {
		id: string;
		definition_json: string;
		definition_hash: string;
		enabled: number;
		generation: number;
	} | null;
	if (!row?.enabled) return null;
	return {
		...(JSON.parse(row.definition_json) as Definition),
		revisionId: row.id,
		hash: row.definition_hash,
		generation: row.generation,
	};
}

/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{ id: "capabilities/0001-init", sql: migration },
	{ id: "capabilities/0002-learned", sql: learnedMigration },
];
