import { seedBuiltins } from "./builtin-seed";
import { createDotsPackages } from "./dots-packages";
import { registerRevision } from "./registry";
import { zSchema } from "./schema";
import { createRequirements } from "./requirements";
import { createToolchains } from "./toolchains";
import { createBound, finishPrepare } from "./bound";
import { createPublishing } from "./publishing";
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
	type BundleHost,
} from "../contracts";
import { get } from "../repository";
export function createCapabilities(
	store: SqliteStore,
	backends = new Set(["web"]),
	options: {
		/** What this host can execute; bundles that need more are not registered. */
		bundleHost?: () => BundleHost;
		now?: () => number;
	} = {},
) {
	const now = options.now ?? Date.now;
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
		register(db, d, "builtin");
	}
	const register = (db: Database, d: Definition, origin: "builtin" | "user") =>
		registerRevision(db, d, origin, closure, now);

	function validate(db: Database, p: Prepared) {
		for (const fixed of [p.package, ...p.dependencies]) {
			const current = get(db, fixed.revisionId);
			if (
				!current ||
				current.hash !== fixed.hash ||
				current.generation !== fixed.generation ||
				(current.schemaKey &&
					(!validators[current.schemaKey] ||
						current.schemaHash !== hash(zSchema(current.schemaKey))))
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
					`SELECT i.key FROM capability_items i JOIN capability_revisions r ON r.id=i.active_revision_id WHERE i.kind='package' AND i.enabled=1 AND (i.id=? OR EXISTS(SELECT 1 FROM json_each(r.definition_json,'$.aliases') WHERE value=? OR (length(value)>=2 AND instr(?,value)>0))) LIMIT 32`,
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
	const toolchains = createToolchains(closure, now);
	const bound = createBound({
		closure,
		register: registerBuiltinInTransaction,
		now,
	});
	return {
		...createRequirements(store, register),
		...createDotsPackages(store, register),
		...toolchains,
		...createPublishing(store, toolchains),
		instructionInTransaction(db: Database, revisionId: string) {
			const definition = closure(db, revisionId)[0];
			if (
				!definition ||
				!["profile", "skill"].includes(definition.kind) ||
				!definition.body?.trim()
			)
				throw new Error("required_context_missing");
			return {
				revisionId: definition.revisionId,
				hash: definition.hash,
				body: definition.body,
			};
		},
		getDefinitionInTransaction,
		registerBuiltinInTransaction,
		...bound.api,
		validateInTransaction: validate,
		searchInTransaction: search,
		prepareInTransaction: prepare,
		seed: () =>
			store.write((db) => {
				seedBuiltins(db, backends, registerBuiltinInTransaction);
				bound.seedBundlesInTransaction(db, options.bundleHost?.());
			}),
		list(cursor = "", limit = 50) {
			return store.read((db) => {
				const rows = db
					.query(
						`SELECT active_revision_id,key FROM capability_items WHERE kind='package' AND enabled=1 AND key>? ORDER BY key LIMIT ?`,
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
export { zSchema } from "./schema";
export type Capabilities = ReturnType<typeof createCapabilities>;
