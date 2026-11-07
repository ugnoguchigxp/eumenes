import type { Database } from "bun:sqlite";
import type { ScopeRef } from "eumenes-world-model";
import { sha256Hex } from "../../../infrastructure/digest";

export const workingSetMigration = `
CREATE TABLE world_host_use_exclusion (
 principal TEXT NOT NULL, scope_key TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('claim','document')),
 id TEXT NOT NULL, revision TEXT NOT NULL,
 PRIMARY KEY(principal,scope_key,kind,id,revision)
) WITHOUT ROWID;
`;

export function excludedRefs(db: Database, scope: ScopeRef) {
	return db
		.query(
			"SELECT kind,id,revision FROM world_host_use_exclusion WHERE principal=? AND scope_key=?",
		)
		.all(scope.principal, scope.scopeKey) as Array<{
		kind: "claim" | "document";
		id: string;
		revision: string;
	}>;
}

export function workingSetDigest(db: Database, scope: ScopeRef): string {
	return sha256Hex(
		JSON.stringify(
			excludedRefs(db, scope)
				.map((r) => [r.kind, r.id, r.revision])
				.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
		),
	);
}

export function isExcluded(
	db: Database,
	scope: ScopeRef,
	kind: "claim" | "document",
	id: string,
	revision: string | number,
): boolean {
	return (
		db
			.query(
				"SELECT 1 FROM world_host_use_exclusion WHERE principal=? AND scope_key=? AND kind=? AND id=? AND revision=?",
			)
			.get(scope.principal, scope.scopeKey, kind, id, String(revision)) !== null
	);
}

export function setExcluded(
	db: Database,
	scope: ScopeRef,
	ref: { kind: "claim" | "document"; id: string; revision: string },
	excluded: boolean,
) {
	if (!db.inTransaction) throw new Error("transaction_required");
	if (excluded)
		db.query(
			"INSERT OR IGNORE INTO world_host_use_exclusion(principal,scope_key,kind,id,revision) VALUES(?,?,?,?,?)",
		).run(scope.principal, scope.scopeKey, ref.kind, ref.id, ref.revision);
	else
		db.query(
			"DELETE FROM world_host_use_exclusion WHERE principal=? AND scope_key=? AND kind=? AND id=? AND revision=?",
		).run(scope.principal, scope.scopeKey, ref.kind, ref.id, ref.revision);
}

/** Owner inventory: archived material is still stored, withdrawn material is never restorable here. */
export function storedDocuments(db: Database, scope: ScopeRef) {
	return db
		.query(
			"SELECT id,revision,title,collection,digest FROM world_host_document WHERE principal=? AND scope_key=? AND withdrawn=0 ORDER BY id LIMIT 2501",
		)
		.all(scope.principal, scope.scopeKey) as Array<{
		id: string;
		revision: string;
		title: string;
		collection: string;
		digest: string;
	}>;
}
