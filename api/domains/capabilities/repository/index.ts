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
export const toolchainVectorsMigration = `
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
export const documentsMigration = `
CREATE TABLE capability_documents(
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('binding','http-binding','artifact','schema')),
 item_id TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,
 document_json TEXT NOT NULL,bundle_id TEXT NOT NULL,created_at_ms INTEGER NOT NULL,
 UNIQUE(kind,item_id,revision));
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
];

export type DocumentKind = "binding" | "http-binding" | "artifact" | "schema";
export type StoredDocument = {
	revisionId: string;
	kind: DocumentKind;
	digest: string;
	document: unknown;
};
/** The id prefix of a document kind (`binding:` is shared by command and HTTP bindings). */
export const documentPrefix = (kind: DocumentKind) =>
	kind === "http-binding" ? "binding" : kind;
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
