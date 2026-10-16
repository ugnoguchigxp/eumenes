import type { Database } from "bun:sqlite";
import type {
	WorldDocumentInput,
	WorldDocumentScope,
} from "../contracts/documents";

export const documentsMigration = `
CREATE TABLE world_host_document (
 principal TEXT NOT NULL, scope_key TEXT NOT NULL, id TEXT NOT NULL,
 revision TEXT NOT NULL, title TEXT NOT NULL, collection TEXT NOT NULL,
 manifest_digest TEXT NOT NULL, content TEXT NOT NULL, digest TEXT NOT NULL,
 withdrawn INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1)),
 PRIMARY KEY (principal, scope_key, id)
) WITHOUT ROWID;
`;
type Row = WorldDocumentInput & { withdrawn: number };
const columns =
	"id, revision, title, collection, manifest_digest AS manifestDigest, content, digest, withdrawn";
export function readDocument(
	db: Database,
	scope: WorldDocumentScope,
	id: string,
): Row | null {
	return db
		.query(
			`SELECT ${columns} FROM world_host_document WHERE principal=?1 AND scope_key=?2 AND id=?3`,
		)
		.get(scope.principal, scope.scopeKey, id) as Row | null;
}
export function searchDocuments(
	db: Database,
	scope: WorldDocumentScope,
	query: string,
	offset: number,
) {
	return db
		.query(`SELECT id, revision, title, collection FROM world_host_document
	 WHERE principal=?1 AND scope_key=?2 AND withdrawn=0
	 AND (instr(lower(title), lower(?3))>0 OR instr(lower(content), lower(?3))>0)
	 ORDER BY id LIMIT 11 OFFSET ?4`)
		.all(scope.principal, scope.scopeKey, query, offset) as Pick<
		Row,
		"id" | "revision" | "title" | "collection"
	>[];
}
export function insertDocument(
	db: Database,
	scope: WorldDocumentScope,
	doc: WorldDocumentInput,
) {
	if (!db.inTransaction) throw new Error("transaction_required");
	db.query(`INSERT INTO world_host_document
	 (principal, scope_key, id, revision, title, collection, manifest_digest, content, digest)
	 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`).run(
		scope.principal,
		scope.scopeKey,
		doc.id,
		doc.revision,
		doc.title,
		doc.collection,
		doc.manifestDigest,
		doc.content,
		doc.digest,
	);
}
export function withdrawDocument(
	db: Database,
	scope: WorldDocumentScope,
	id: string,
) {
	if (!db.inTransaction) throw new Error("transaction_required");
	// Keep only the identity tombstone: re-import must never silently restore withdrawn text.
	return (
		db
			.query(
				`UPDATE world_host_document SET withdrawn=1, content='', title='', collection='', manifest_digest='' WHERE principal=?1 AND scope_key=?2 AND id=?3`,
			)
			.run(scope.principal, scope.scopeKey, id).changes > 0
	);
}
