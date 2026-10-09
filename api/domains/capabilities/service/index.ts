import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	bytes,
	hash,
	validators,
	type Definition,
	type Owner,
	type Candidate,
	type Prepared,
	type FixedDefinition,
} from "../contracts";
import { get } from "../repository";
import { builtins } from "../builtin/web-research";
export function createCapabilities(
	store: SqliteStore,
	backends = new Set(["web"]),
	now = Date.now,
) {
	const refs = new Map<
		string,
		{ owner: Owner; expires: number; revisionId: string; bundleDigest: string }
	>();
	const ownerKey = (o: Owner) => JSON.stringify(o);
	const bundleDigest = (items: FixedDefinition[]) =>
		hash(
			items.map((item) => ({
				revisionId: item.revisionId,
				hash: item.hash,
				generation: item.generation,
			})),
		);
	function closure(
		db: Database,
		revisionId: string,
		seen = new Set<string>(),
		path = new Set<string>(),
	): FixedDefinition[] {
		if (path.has(revisionId)) throw new Error("capability_cycle");
		if (seen.has(revisionId)) return [];
		const value = get(db, revisionId);
		if (!value) throw new Error("capability_unavailable");
		if (value.backend && !backends.has(value.backend))
			throw new Error("capability_unavailable");
		seen.add(revisionId);
		path.add(revisionId);
		const children = value.dependencies.flatMap((id) =>
			closure(db, id, seen, path),
		);
		path.delete(revisionId);
		return [value, ...children];
	}
	function registerBuiltinInTransaction(db: Database, d: Definition) {
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
			if (old.definition_hash !== digest)
				throw new Error("capability_revision_conflict");
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
		db.query(
			"INSERT INTO capability_items(key,id,kind,active_revision_id) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET active_revision_id=excluded.active_revision_id,generation=generation+1",
		).run(key, d.id, d.kind, rev);
		for (const dependency of d.dependencies)
			db.query("INSERT INTO capability_dependencies VALUES(?,?)").run(
				rev,
				dependency,
			);
		db.query("DELETE FROM capability_search WHERE key=?").run(key);
		db.query("INSERT INTO capability_search(key,content) VALUES(?,?)").run(
			key,
			[d.id, d.title, d.summary, ...d.aliases, ...d.tags, ...d.useWhen].join(
				" ",
			),
		);
	}
	function validate(db: Database, p: Prepared) {
		for (const fixed of [p.package, ...p.dependencies]) {
			const current = get(db, fixed.revisionId);
			if (
				!current ||
				current.hash !== fixed.hash ||
				current.generation !== fixed.generation ||
				(current.schemaKey &&
					current.schemaHash !== hash(zSchema(current.schemaKey)))
			)
				throw new Error("capability_revoked");
		}
	}
	function search(
		db: Database,
		owner: Owner,
		intent: string,
		terms: string[],
		deadline: number,
		limit = 5,
	): Candidate[] {
		for (const [key, r] of refs) if (r.expires <= now()) refs.delete(key);
		if (
			intent.length > 400 ||
			terms.length > 8 ||
			terms.some((t) => t.length > 80)
		)
			throw new Error("invalid_capability_search");
		const long = terms
			.filter((t) => t.length >= 3)
			.map((t) => '"' + t.replaceAll('"', '""') + '"')
			.join(" OR ");
		const keys = new Map<string, number>();
		if (long)
			for (const row of db
				.query(
					"SELECT key,bm25(capability_search) AS rank FROM capability_search WHERE capability_search MATCH ? ORDER BY rank LIMIT 128",
				)
				.all(long) as { key: string; rank: number }[])
				keys.set(row.key, row.rank);
		for (const term of [...terms, intent])
			for (const row of db
				.query(
					"SELECT i.key FROM capability_items i JOIN capability_revisions r ON r.id=i.active_revision_id WHERE i.kind='package' AND i.enabled=1 AND (i.id=? OR EXISTS(SELECT 1 FROM json_each(r.definition_json,'$.aliases') WHERE value=? OR (length(value)>=2 AND instr(?,value)>0))) LIMIT 32",
				)
				.all(term, term, term) as { key: string }[])
				keys.set(row.key, -1000);
		const candidates = [...keys]
			.filter(([k]) => k.startsWith("package:"))
			.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
		const out: Candidate[] = [];
		for (const [key] of candidates) {
			const row = db
				.query(
					"SELECT active_revision_id FROM capability_items WHERE key=? AND enabled=1",
				)
				.get(key) as { active_revision_id: string } | null;
			if (!row) continue;
			let all: FixedDefinition[];
			try {
				all = closure(db, row.active_revision_id);
			} catch {
				continue;
			}
			const d = all[0]!;
			if (
				[...refs.values()].filter((r) => ownerKey(r.owner) === ownerKey(owner))
					.length >= 64
			)
				throw new Error("reference_capacity");
			const candidateRef = crypto.randomUUID();
			const card = {
				candidateRef,
				id: d.id,
				title: d.title,
				summary: d.summary,
				useWhen: d.useWhen,
				avoidWhen: d.avoidWhen,
			};
			if (bytes([...out, card]) > 8192) break;
			refs.set(candidateRef, {
				owner,
				expires: Math.min(now() + 300000, deadline),
				revisionId: d.revisionId,
				bundleDigest: bundleDigest(all),
			});
			out.push(card);
			if (out.length >= Math.min(8, Math.max(1, limit))) break;
		}
		return out;
	}
	function prepare(
		db: Database,
		owner: Owner,
		ref: string,
		input: unknown,
	): Prepared {
		const r = refs.get(ref);
		if (!r || r.expires <= now() || ownerKey(r.owner) !== ownerKey(owner))
			throw new Error("capability_ref_invalid");
		const all = closure(db, r.revisionId),
			pack = all[0]!;
		if (bundleDigest(all) !== r.bundleDigest)
			throw new Error("capability_ref_invalid");
		if (pack.kind !== "package" || !pack.schemaKey)
			throw new Error("invalid_capability");
		const parsed = validators[pack.schemaKey].safeParse(input);
		if (!parsed.success) throw new Error("invalid_capability_input");
		const dependencies = all.slice(1);
		const required = dependencies.map(
			(d) => d.body ?? (d.schemaKey ? zSchema(d.schemaKey) : ""),
		);
		if (
			dependencies.filter((d) => d.kind === "skill").length > 4 ||
			bytes(required) > 16384
		)
			throw new Error("required_context_overflow");
		return { package: pack, dependencies, input: parsed.data };
	}
	return {
		registerBuiltinInTransaction,
		validateInTransaction: validate,
		searchInTransaction: search,
		prepareInTransaction: prepare,
		seed: () =>
			store.write((db) => {
				for (const d of builtins) registerBuiltinInTransaction(db, d);
			}),
		list(cursor = "", limit = 50) {
			return store.read((db) => {
				const rows = db
					.query(
						"SELECT active_revision_id,key FROM capability_items WHERE kind='package' AND enabled=1 AND key>? ORDER BY key LIMIT ?",
					)
					.all(cursor, Math.min(50, Math.max(1, limit)) + 1) as {
					active_revision_id: string;
					key: string;
				}[];
				return {
					items: rows.slice(0, limit).flatMap((r) => {
						try {
							const d = closure(db, r.active_revision_id)[0]!;
							return [{ id: d.id, title: d.title, summary: d.summary }];
						} catch {
							return [];
						}
					}),
					nextCursor: rows.length > limit ? rows[limit - 1]?.key : null,
				};
			});
		},
		setEnabledInTransaction(
			db: Database,
			kind: Definition["kind"],
			id: string,
			enabled: boolean,
		) {
			if (
				db
					.query(
						"UPDATE capability_items SET enabled=?,generation=generation+1 WHERE key=?",
					)
					.run(enabled ? 1 : 0, `${kind}:${id}`).changes !== 1
			)
				throw new Error("capability_not_found");
		},
		releaseOwner(taskId: string) {
			for (const [key, r] of refs)
				if (r.owner.taskId === taskId) refs.delete(key);
		},
		close: () => refs.clear(),
	};
}
import { z } from "zod";
export const zSchema = (key: keyof typeof validators) =>
	z.toJSONSchema(validators[key]);
export type Capabilities = ReturnType<typeof createCapabilities>;
