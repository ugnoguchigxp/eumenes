import type { Database } from "bun:sqlite";
import type { HostSourceState } from "eumenes-memory/sqlite";
import type { ForgetPurge } from "../contracts";

export const SEED_NAMESPACE = "memory-seed";
/** Opaque provenance carried by the existing durable block journal, including pre-import DB restores. */
export const SEED_IMPORT_FENCE = "memory.seed-import";
export const seedImportMigration = `
CREATE TABLE memory_seed_import (id INTEGER PRIMARY KEY CHECK(id = 1), digest TEXT NOT NULL);
CREATE TABLE memory_seed_source (source_id TEXT PRIMARY KEY, item_id TEXT NOT NULL, source_json TEXT NOT NULL);
CREATE INDEX memory_seed_source_item ON memory_seed_source(item_id);
`;

export function seedImportDigest(db: Database): string | null {
	return (
		(
			db.query("SELECT digest FROM memory_seed_import WHERE id = 1").get() as {
				digest: string;
			} | null
		)?.digest ?? null
	);
}
export function putSeedImport(db: Database, digest: string) {
	const existing = seedImportDigest(db);
	if (existing !== null && existing !== digest)
		throw new Error("invalid_memory_seed_fence");
	db.query(
		"INSERT OR IGNORE INTO memory_seed_import (id, digest) VALUES (1, ?)",
	).run(digest);
}
export function putSeedSource(
	db: Database,
	source: HostSourceState,
	itemId: string,
) {
	db.query(
		"INSERT INTO memory_seed_source (source_id, item_id, source_json) VALUES (?, ?, ?)",
	).run(source.id, itemId, JSON.stringify(source));
}
export function readSeedSource(
	db: Database,
	id: string,
): HostSourceState | null {
	const row = db
		.query("SELECT source_json FROM memory_seed_source WHERE source_id = ?")
		.get(id) as { source_json: string } | null;
	return row ? (JSON.parse(row.source_json) as HostSourceState) : null;
}
export function seedFenceForItems(
	db: Database,
	itemIds: ReadonlySet<string>,
): string | null {
	const rows = db
		.query("SELECT item_id FROM memory_seed_source")
		.all() as Array<{ item_id: string }>;
	return rows.some((r) => itemIds.has(r.item_id)) ? seedImportDigest(db) : null;
}
/** No candidate body survives the forget; the digest fence survives even restoring a pre-import database. */
export function purgeSeedSources(db: Database, purge: ForgetPurge) {
	for (const digest of purge.derived[SEED_IMPORT_FENCE] ?? [])
		putSeedImport(db, digest);
	const remove = db.query("DELETE FROM memory_seed_source WHERE item_id = ?");
	for (const id of purge.itemIds) remove.run(id);
}
