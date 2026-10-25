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

/** Passage embeddings of toolchains, per vector space. Appended migration. */
const toolchainVectorsMigration = `
CREATE TABLE capability_toolchain_vectors(
 revision_id TEXT NOT NULL,item INTEGER NOT NULL,space TEXT NOT NULL,
 text_digest TEXT NOT NULL,vector BLOB NOT NULL,
 PRIMARY KEY(revision_id,item,space));
CREATE INDEX capability_toolchain_vectors_space ON capability_toolchain_vectors(space);
`;
/**
 * Immutable binding, artifact and schema revisions shipped by bundles. A toolchain revision
 * refers to them by id; they are never updated, and an id never changes its digest.
 */
const documentsMigration = `
CREATE TABLE capability_documents(
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('binding','http-binding','artifact','schema')),
 item_id TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,
 document_json TEXT NOT NULL,bundle_id TEXT NOT NULL,created_at_ms INTEGER NOT NULL,
 UNIQUE(kind,item_id,revision));
`;
/**
 * The published revision of an artifact that is shown on its own (it has a `launcher`): a
 * pointer into `capability_documents`, switched by registering a newer revision or by an
 * explicit publish, as the active revision of a toolchain is.
 */
const artifactPointersMigration = `
CREATE TABLE capability_artifact_pointers(
 artifact_id TEXT PRIMARY KEY,active_revision_id TEXT NOT NULL,
 generation INTEGER NOT NULL DEFAULT 0,updated_at_ms INTEGER NOT NULL);
`;
/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{ id: "capabilities/0001-init", sql: migration },
	{ id: "capabilities/0002-learned", sql: learnedMigration },
	{
		id: "capabilities/0003-toolchain-vectors",
		sql: toolchainVectorsMigration,
		after: ["capabilities/0002-learned"],
	},
	{
		id: "capabilities/0004-bindings",
		sql: documentsMigration,
		after: ["capabilities/0003-toolchain-vectors"],
	},
	{
		id: "capabilities/0005-artifact-pointers",
		sql: artifactPointersMigration,
		after: ["capabilities/0004-bindings"],
	},
	{
		// The Web research toolchain moved to a model-neutral id (`web.research.codex`). Its earlier item,
		// named after the model, keeps its revisions as history but no longer holds a function name,
		// a search entry or an embedding.
		id: "capabilities/0006-retire-model-named-web-research",
		sql: `DELETE FROM capability_toolchain_vectors WHERE revision_id IN (SELECT r.id FROM capability_revisions r JOIN capability_items i ON i.key=r.item_key WHERE i.kind='toolchain' AND i.id LIKE 'web.research.%' AND i.id<>'web.research.codex');
DELETE FROM capability_search WHERE key IN (SELECT key FROM capability_items WHERE kind='toolchain' AND id LIKE 'web.research.%' AND id<>'web.research.codex');
DELETE FROM capability_items WHERE kind='toolchain' AND id LIKE 'web.research.%' AND id<>'web.research.codex';`,
		after: ["capabilities/0005-artifact-pointers"],
	},
	{
		// The `steward.request` toolchain (the `memory_request` tool) is gone: the conversation agent's fixed memory
		// tool asks the steward directly. Its items (the toolchain and its package, profile, skill and tool) keep their
		// revisions as history but no longer hold a function name, a search entry or an embedding.
		id: "capabilities/0007-retire-steward-request",
		sql: `DELETE FROM capability_toolchain_vectors WHERE revision_id IN (SELECT id FROM capability_revisions WHERE item_key LIKE '%:steward.request');
DELETE FROM capability_search WHERE key IN (SELECT key FROM capability_items WHERE id='steward.request' AND kind IN ('toolchain','package','profile','skill','tool'));
DELETE FROM capability_items WHERE id='steward.request' AND kind IN ('toolchain','package','profile','skill','tool');`,
		after: ["capabilities/0006-retire-model-named-web-research"],
	},
	{
		// The `web.research.codex` toolchain (the `web_research` tool) is gone: research runs on the one LLM Eumenes is
		// configured with. Its revisions stay as history but the item no longer holds a function name, a search entry
		// or an embedding.
		id: "capabilities/0008-retire-web-research-codex",
		sql: `DELETE FROM capability_toolchain_vectors WHERE revision_id IN (SELECT id FROM capability_revisions WHERE item_key='toolchain:web.research.codex');
DELETE FROM capability_search WHERE key='toolchain:web.research.codex';
DELETE FROM capability_items WHERE key='toolchain:web.research.codex';`,
		after: ["capabilities/0007-retire-steward-request"],
	},
];

export type DocumentKind = "binding" | "artifact" | "schema";
export type StoredDocument = {
	revisionId: string;
	kind: DocumentKind;
	digest: string;
	document: unknown;
};
export function getDocument(
	db: Database,
	revisionId: string,
): StoredDocument | null {
	const row = db
		.query(
			"SELECT id,kind,digest,document_json FROM capability_documents WHERE id=?",
		)
		.get(revisionId) as {
		id: string;
		kind: DocumentKind;
		digest: string;
		document_json: string;
	} | null;
	return row
		? {
				revisionId: row.id,
				kind: row.kind,
				digest: row.digest,
				document: JSON.parse(row.document_json),
			}
		: null;
}
export function insertDocument(
	db: Database,
	row: {
		revisionId: string;
		kind: DocumentKind;
		itemId: string;
		revision: number;
		digest: string;
		document: unknown;
		bundleId: string;
		createdAtMs: number;
	},
) {
	db.query(
		"INSERT INTO capability_documents(id,kind,item_id,revision,digest,document_json,bundle_id,created_at_ms) VALUES(?,?,?,?,?,?,?,?)",
	).run(
		row.revisionId,
		row.kind,
		row.itemId,
		row.revision,
		row.digest,
		JSON.stringify(row.document),
		row.bundleId,
		row.createdAtMs,
	);
}

export function setArtifactPointer(
	db: Database,
	artifactId: string,
	revisionId: string,
	nowMs: number,
) {
	db.query(
		"INSERT INTO capability_artifact_pointers(artifact_id,active_revision_id,updated_at_ms) VALUES(?,?,?) ON CONFLICT(artifact_id) DO UPDATE SET active_revision_id=excluded.active_revision_id,generation=generation+1,updated_at_ms=excluded.updated_at_ms",
	).run(artifactId, revisionId, nowMs);
}
export function clearArtifactPointer(db: Database, artifactId: string) {
	db.query("DELETE FROM capability_artifact_pointers WHERE artifact_id=?").run(
		artifactId,
	);
}
/** Published revision ids of the standalone artifacts, in id order. */
export function artifactPointers(db: Database): string[] {
	return (
		db
			.query(
				"SELECT active_revision_id r FROM capability_artifact_pointers ORDER BY artifact_id",
			)
			.all() as { r: string }[]
	).map((row) => row.r);
}
/** The published revision of a standalone artifact, or null when none is published. */
export function artifactPointer(db: Database, artifactId: string) {
	return (
		(
			db
				.query(
					"SELECT active_revision_id r FROM capability_artifact_pointers WHERE artifact_id=?",
				)
				.get(artifactId) as { r: string } | null
		)?.r ?? null
	);
}
