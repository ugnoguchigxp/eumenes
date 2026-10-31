import type { Database } from "bun:sqlite";

// ---- provenance: who asked for a State item ----

/** `manual`: only rows written before manual changes were removed (an item with no row reads as `manual` too). */
export type Provenance = "request" | "agent" | "manual";
export function putProvenance(
	db: Database,
	itemId: string,
	runId: string | null,
	mode: Provenance,
	now: string,
	/** Whether the model's quote was found in the message (null: no quote was involved). */
	quoteMatched: boolean | null = null,
) {
	db.query(
		"INSERT OR REPLACE INTO memory_item_provenance (item_id, run_id, mode, created_at, quote_matched) VALUES (?,?,?,?,?)",
	).run(
		itemId,
		runId,
		mode,
		now,
		quoteMatched === null ? null : quoteMatched ? 1 : 0,
	);
}
export function provenanceOf(db: Database, itemId: string): Provenance {
	const row = db
		.query("SELECT mode FROM memory_item_provenance WHERE item_id = ?")
		.get(itemId) as { mode: Provenance } | null;
	return row?.mode ?? "manual";
}
/** Forgotten items leave no provenance and no merge lineage (as the merged item or as a source). */
export function deleteProvenance(db: Database, itemIds: readonly string[]) {
	const remove = db.query(
		"DELETE FROM memory_item_provenance WHERE item_id = ?",
	);
	const removeMerged = db.query(
		"DELETE FROM memory_item_merge WHERE item_id = ?",
	);
	const removeSource = db.query(
		"DELETE FROM memory_item_merge WHERE source_id = ?",
	);
	for (const id of itemIds) {
		remove.run(id);
		removeMerged.run(id);
		removeSource.run(id);
	}
}
/** A merge: `itemId` was made from the sources (which were stopped). Forgetting any of them forgets all. */
export function putMergeLineage(
	db: Database,
	itemId: string,
	sourceIds: readonly string[],
) {
	const insert = db.query(
		"INSERT OR IGNORE INTO memory_item_merge (item_id, source_id) VALUES (?,?)",
	);
	for (const sourceId of sourceIds) insert.run(itemId, sourceId);
}
/** The items directly linked to this one by a merge, in either direction (what it was merged from, what it was merged into). */
export function mergeNeighbours(db: Database, itemId: string): string[] {
	const rows = db
		.query(
			`SELECT source_id AS id FROM memory_item_merge WHERE item_id = ?1
			 UNION SELECT item_id AS id FROM memory_item_merge WHERE source_id = ?1`,
		)
		.all(itemId) as Array<{ id: string }>;
	return rows.map((row) => row.id);
}

// ---- tendencies: observations the agent derived from several items ----

export interface TendencyEvidence {
	namespace: "state" | "continuity";
	id: string;
}
export interface TendencyFull {
	id: string;
	text: string;
	evidence: TendencyEvidence[];
	status: "active" | "retired";
	revision: number;
	createdAt: string;
	updatedAt: string;
}
const tendencyColumns =
	"id, text, evidence, status, revision, created_at AS createdAt, updated_at AS updatedAt";
function mapTendency(row: Record<string, unknown>): TendencyFull {
	return {
		id: row.id as string,
		text: row.text as string,
		evidence: JSON.parse(row.evidence as string) as TendencyEvidence[],
		status: row.status as TendencyFull["status"],
		revision: row.revision as number,
		createdAt: row.createdAt as string,
		updatedAt: row.updatedAt as string,
	};
}
export function getTendency(db: Database, id: string): TendencyFull | null {
	const row = db
		.query(`SELECT ${tendencyColumns} FROM memory_tendency WHERE id = ?`)
		.get(id) as Record<string, unknown> | null;
	return row ? mapTendency(row) : null;
}
export function countActiveTendencies(db: Database): number {
	return (
		db
			.query(
				"SELECT COUNT(*) AS n FROM memory_tendency WHERE status = 'active'",
			)
			.get() as { n: number }
	).n;
}
/** Active tendencies, newest first (the order the agent sees them in). */
export function listActiveTendencies(db: Database): TendencyFull[] {
	return (
		db
			.query(
				`SELECT ${tendencyColumns} FROM memory_tendency WHERE status = 'active' ORDER BY updated_at DESC, id`,
			)
			.all() as Record<string, unknown>[]
	).map(mapTendency);
}
function bumpTendencyRevision(db: Database) {
	db.query(
		"UPDATE memory_tendency_revision SET revision = revision + 1 WHERE id = 1",
	).run();
}
export function insertTendency(db: Database, row: TendencyFull) {
	db.query(
		"INSERT INTO memory_tendency (id, text, evidence, status, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
	).run(
		row.id,
		row.text,
		JSON.stringify(row.evidence),
		row.status,
		row.revision,
		row.createdAt,
		row.updatedAt,
	);
	bumpTendencyRevision(db);
}
/** Rewrites an active tendency at its expected revision; false when it moved on. */
export function updateTendency(
	db: Database,
	id: string,
	expectedRevision: number,
	change: { text: string; evidence: TendencyEvidence[] },
	now: string,
): boolean {
	const result = db
		.query(
			"UPDATE memory_tendency SET text=?, evidence=?, revision=revision+1, updated_at=? WHERE id=? AND revision=? AND status='active'",
		)
		.run(
			change.text,
			JSON.stringify(change.evidence),
			now,
			id,
			expectedRevision,
		);
	if (result.changes !== 1) return false;
	bumpTendencyRevision(db);
	return true;
}
export function retireTendency(
	db: Database,
	id: string,
	expectedRevision: number,
	now: string,
): boolean {
	const result = db
		.query(
			"UPDATE memory_tendency SET status='retired', revision=revision+1, updated_at=? WHERE id=? AND revision=? AND status='active'",
		)
		.run(now, id, expectedRevision);
	if (result.changes !== 1) return false;
	bumpTendencyRevision(db);
	return true;
}
/** Ids bound per statement: far below SQLite's variable limit. */
const EVIDENCE_CHUNK = 500;
/**
 * Physical delete of every tendency (active or retired) that names one of the items as evidence: a
 * forgotten item (or a note retracted with it) must not live on in a summary derived from it.
 * Bumps the revision once when any row went.
 */
export function deleteTendenciesByEvidence(
	db: Database,
	namespace: TendencyEvidence["namespace"],
	itemIds: readonly string[],
): number {
	const unique = [...new Set(itemIds)];
	let deleted = 0;
	for (let start = 0; start < unique.length; start += EVIDENCE_CHUNK) {
		const chunk = unique.slice(start, start + EVIDENCE_CHUNK);
		const marks = chunk.map(() => "?").join(",");
		deleted += db
			.query(
				`DELETE FROM memory_tendency WHERE EXISTS (
					SELECT 1 FROM json_each(memory_tendency.evidence) AS e
					WHERE json_extract(e.value, '$.namespace') = ? AND json_extract(e.value, '$.id') IN (${marks})
				)`,
			)
			.run(namespace, ...chunk).changes;
	}
	if (deleted > 0) bumpTendencyRevision(db);
	return deleted;
}
