import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import {
	bytes,
	hash,
	validators,
	type Definition,
	type FixedDefinition,
} from "../contracts";
import { zSchema } from "./schema";
export function registerRevision(
	db: Database,
	d: Definition,
	origin: "builtin" | "learned" | "user",
	closure: (db: Database, revisionId: string) => FixedDefinition[],
	now: () => number,
	hasLearned: (db: Database) => boolean,
) {
	if (d.schemaKey) {
		const actual = hash(zSchema(d.schemaKey));
		if (d.schemaHash && actual !== d.schemaHash)
			throw new Error("invalid_capability_schema");
		d = { ...d, schemaHash: actual };
	}
	if (
		!/^[a-z][a-z0-9._-]{0,100}$/.test(d.id) ||
		!Number.isInteger(d.revision) ||
		d.revision < 1 ||
		bytes(d) > 32768
	)
		throw new Error("invalid_capability");
	if (d.schemaKey && !validators[d.schemaKey])
		throw new Error("invalid_capability_schema");
	const key = `${d.kind}:${d.id}`,
		rev = `${key}@${d.revision}`,
		digest = hash(d);
	const old = db
		.query("SELECT definition_hash FROM capability_revisions WHERE id=?")
		.get(rev) as { definition_hash: string } | null;
	if (old) {
		if (old.definition_hash !== digest) {
			if (origin === "builtin")
				getLogger("capabilities").warn("capability.revision_conflict", {
					subjectId: rev,
					reason: "capability_revision_conflict",
				});
			throw new Error("capability_revision_conflict");
		}
		return;
	}
	const dependencies = d.dependencies.flatMap((id) => closure(db, id));
	if (d.kind === "package") {
		const has = (id: string | undefined, kind: Definition["kind"]) =>
			!!id &&
			dependencies.some(
				(item) =>
					item.revisionId === id &&
					item.kind === kind &&
					(kind === "tool" ? !!item.schemaKey : !!item.body?.trim()),
			);
		if (
			!has(d.profileRevisionId, "profile") ||
			!d.requiredSkillRevisionIds?.length ||
			d.requiredSkillRevisionIds.some((id) => !has(id, "skill")) ||
			!d.toolRevisionIds?.length ||
			d.toolRevisionIds.some((id) => !has(id, "tool"))
		)
			throw new Error("invalid_capability_bundle");
	}
	db.query("INSERT INTO capability_revisions VALUES(?,?,?,?,?,?)").run(
		rev,
		key,
		d.revision,
		JSON.stringify(d),
		digest,
		now(),
	);
	if (hasLearned(db))
		db.query(
			"INSERT INTO capability_items(key,id,kind,active_revision_id,discovery_mode,origin) VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET active_revision_id=excluded.active_revision_id,generation=generation+1",
		).run(
			key,
			d.id,
			d.kind,
			rev,
			origin === "learned" ? "route-only" : "catalog",
			origin,
		);
	else if (origin === "learned") throw new Error("learned_migration_missing");
	else
		db.query(
			"INSERT INTO capability_items(key,id,kind,active_revision_id) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET active_revision_id=excluded.active_revision_id,generation=generation+1",
		).run(key, d.id, d.kind, rev);
	for (const dependency of d.dependencies)
		db.query("INSERT INTO capability_dependencies VALUES(?,?)").run(
			rev,
			dependency,
		);
	if (origin === "learned" || d.kind === "requirement") return;
	db.query("DELETE FROM capability_search WHERE key=?").run(key);
	db.query("INSERT INTO capability_search(key,content) VALUES(?,?)").run(
		key,
		[d.id, d.title, d.summary, ...d.aliases, ...d.tags, ...d.useWhen].join(" "),
	);
}
