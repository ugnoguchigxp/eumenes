import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { getLogger } from "../../../infrastructure/logger";
import {
	bytes,
	hash,
	validators,
	type Definition,
	type Owner,
	type Candidate,
	type Prepared,
	type FixedDefinition,
	learnedIdPattern,
	learnedMaxBytes,
	commonSkillRevisionId,
	commonProfileRevisionId,
} from "../contracts";
import { get } from "../repository";
import { builtins } from "../builtin/web-research";
import { historyBuiltins } from "../builtin/history";
import { timerBuiltins } from "../builtin/timers";
const learnedColumns = new WeakMap<Database, boolean>();
/** The learned-attributes migration is appended; older fixtures may lack it. */
function hasLearned(db: Database) {
	let v = learnedColumns.get(db);
	if (v === undefined) {
		v = (
			db.query("PRAGMA table_info(capability_items)").all() as {
				name: string;
			}[]
		).some((c) => c.name === "discovery_mode");
		learnedColumns.set(db, v);
	}
	return v;
}
function isSupersededBuiltin(d: (typeof builtins)[number]) {
	return builtins.some(
		(next) =>
			next.kind === d.kind && next.id === d.id && next.revision > d.revision,
	);
}
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
		if (d.id.startsWith("learned.") || d.discoveryMode === "route-only")
			throw new Error("invalid_capability");
		register(db, d, "builtin");
	}
	function register(
		db: Database,
		d: Definition,
		origin: "builtin" | "learned",
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
		if (origin === "learned") return;
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
					`SELECT i.key FROM capability_items i JOIN capability_revisions r ON r.id=i.active_revision_id WHERE i.kind='package' AND i.enabled=1 AND ${hasLearned(db) ? "i.discovery_mode='catalog' AND " : ""}(i.id=? OR EXISTS(SELECT 1 FROM json_each(r.definition_json,'$.aliases') WHERE value=? OR (length(value)>=2 AND instr(?,value)>0))) LIMIT 32`,
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
		const all = closure(db, r.revisionId);
		if (bundleDigest(all) !== r.bundleDigest)
			throw new Error("capability_ref_invalid");
		return finishPrepare(all, input);
	}
	function finishPrepare(all: FixedDefinition[], input: unknown): Prepared {
		const pack = all[0]!;
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
	/** Learned definitions: host namespace `learned.web.<32hex>`, revision 1, route-only. */
	function registerLearnedInTransaction(db: Database, d: Definition) {
		if (
			!learnedIdPattern.test(d.id) ||
			d.revision !== 1 ||
			d.discoveryMode !== "route-only" ||
			(d.kind !== "skill" && d.kind !== "package") ||
			bytes(d) > learnedMaxBytes
		)
			throw new Error("invalid_capability");
		if (d.kind === "skill") {
			if (d.dependencies.length || !d.body?.trim())
				throw new Error("invalid_capability_bundle");
		} else {
			const own = `skill:${d.id}@1`;
			const required = d.requiredSkillRevisionIds ?? [];
			// Keep previously persisted bundles valid; new routes use the generic skill.
			const sharedSkill = [commonSkillRevisionId, "skill:web.research@2"].find(
				(id) => required.includes(id),
			);
			if (
				!d.schemaKey ||
				d.profileRevisionId !== commonProfileRevisionId ||
				required.length !== 2 ||
				!sharedSkill ||
				!required.includes(own) ||
				d.toolRevisionIds?.length !== 1 ||
				d.dependencies.length !== 4 ||
				new Set(d.dependencies).size !== 4 ||
				![
					commonProfileRevisionId,
					sharedSkill,
					own,
					d.toolRevisionIds[0],
				].every((x) => d.dependencies.includes(x!))
			)
				throw new Error("invalid_capability_bundle");
			const tool = db
				.query(
					"SELECT origin FROM capability_items WHERE key=(SELECT item_key FROM capability_revisions WHERE id=?)",
				)
				.get(d.toolRevisionIds[0]!) as { origin: string } | null;
			if (
				!tool ||
				tool.origin !== "builtin" ||
				!d.toolRevisionIds[0]!.startsWith("tool:web.")
			)
				throw new Error("invalid_capability_bundle");
		}
		register(db, d, "learned");
	}
	/** Prepare an exact active package revision without candidate search. Same checks as prepare. */
	function prepareActiveByIdInTransaction(
		db: Database,
		owner: Owner,
		revisionId: string,
		input: unknown,
		expect?: { hash?: string; generation?: number },
	): Prepared {
		if (!owner?.taskId || !owner.rootRunId)
			throw new Error("capability_ref_invalid");
		const item = db
			.query(
				"SELECT i.active_revision_id FROM capability_revisions r JOIN capability_items i ON i.key=r.item_key WHERE r.id=?",
			)
			.get(revisionId) as { active_revision_id: string } | null;
		if (!item || item.active_revision_id !== revisionId)
			throw new Error("capability_unavailable");
		const all = closure(db, revisionId);
		if (
			(expect?.hash !== undefined && all[0]!.hash !== expect.hash) ||
			(expect?.generation !== undefined &&
				all[0]!.generation !== expect.generation)
		)
			throw new Error("capability_revoked");
		return finishPrepare(all, input);
	}
	/**
	 * Delete learned route-only packages (and their learned skills) named in `remove`,
	 * except anything in the dependency closure of `protect`. Builtins are never touched.
	 */
	function pruneLearnedInTransaction(
		db: Database,
		input: { remove: string[]; protect: string[] },
	) {
		const rawClosure = (ids: string[]) => {
			const seen = new Set<string>();
			const walk = (id: string) => {
				if (seen.has(id)) return;
				seen.add(id);
				for (const r of db
					.query(
						"SELECT dependency_revision_id d FROM capability_dependencies WHERE revision_id=?",
					)
					.all(id) as { d: string }[])
					walk(r.d);
			};
			ids.forEach(walk);
			return seen;
		};
		if (!hasLearned(db)) return { removed: 0 };
		const protectedSet = rawClosure(input.protect);
		let removed = 0;
		const isLearned = (revisionId: string) =>
			!!db
				.query(
					"SELECT 1 FROM capability_revisions r JOIN capability_items i ON i.key=r.item_key WHERE r.id=? AND i.origin='learned' AND i.discovery_mode='route-only'",
				)
				.get(revisionId);
		for (const id of input.remove) {
			if (!id.startsWith("package:") || !isLearned(id)) continue;
			const closureIds = [...rawClosure([id])].filter(
				(x) => !protectedSet.has(x) && isLearned(x),
			);
			for (const rev of closureIds) {
				const referenced = db
					.query(
						"SELECT 1 FROM capability_dependencies WHERE dependency_revision_id=? AND revision_id NOT IN (SELECT value FROM json_each(?))",
					)
					.get(rev, JSON.stringify(closureIds));
				if (referenced) continue;
				const row = db
					.query("SELECT item_key FROM capability_revisions WHERE id=?")
					.get(rev) as { item_key: string } | null;
				if (!row) continue;
				db.query("DELETE FROM capability_dependencies WHERE revision_id=?").run(
					rev,
				);
				db.query("DELETE FROM capability_revisions WHERE id=?").run(rev);
				if (
					!db
						.query("SELECT 1 FROM capability_revisions WHERE item_key=?")
						.get(row.item_key)
				)
					db.query("DELETE FROM capability_items WHERE key=?").run(
						row.item_key,
					);
				removed++;
			}
		}
		return { removed };
	}
	/** Bytes of learned definitions, for the host-wide 64MiB accounting. */
	function learnedUsageInTransaction(db: Database) {
		if (!hasLearned(db)) return { count: 0, bytes: 0 };
		return db
			.query(
				"SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(r.definition_json AS BLOB))),0) AS bytes FROM capability_revisions r JOIN capability_items i ON i.key=r.item_key WHERE i.origin='learned'",
			)
			.get() as { count: number; bytes: number };
	}
	/** Read-only view of one revision (enabled only). Body is returned for skills only. */
	function getDefinitionInTransaction(db: Database, revisionId: string) {
		const d = get(db, revisionId);
		if (!d) return null;
		return {
			revisionId: d.revisionId,
			hash: d.hash,
			kind: d.kind,
			body: d.kind === "skill" ? (d.body ?? null) : null,
		};
	}
	return {
		getDefinitionInTransaction,
		registerBuiltinInTransaction,
		registerLearnedInTransaction,
		prepareActiveByIdInTransaction,
		pruneLearnedInTransaction,
		learnedUsageInTransaction,
		validateInTransaction: validate,
		searchInTransaction: search,
		prepareInTransaction: prepare,
		seed: () =>
			store.write((db) => {
				for (const d of builtins) {
					if (d.backend && !backends.has(d.backend)) continue;
					// Keep the exact archived definition from this installation. Only
					// the newest revision is authoritative for the current seed.
					const superseded = isSupersededBuiltin(d);
					if (
						superseded &&
						db
							.query("SELECT 1 FROM capability_revisions WHERE id=?")
							.get(`${d.kind}:${d.id}@${d.revision}`)
					)
						continue;
					registerBuiltinInTransaction(db, d);
				}
				if (backends.has("history"))
					for (const d of historyBuiltins) registerBuiltinInTransaction(db, d);
				if (backends.has("timer"))
					for (const d of timerBuiltins) registerBuiltinInTransaction(db, d);
			}),
		list(cursor = "", limit = 50) {
			return store.read((db) => {
				const rows = db
					.query(
						`SELECT active_revision_id,key FROM capability_items WHERE kind='package' AND enabled=1 ${hasLearned(db) ? "AND discovery_mode='catalog'" : ""} AND key>? ORDER BY key LIMIT ?`,
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
