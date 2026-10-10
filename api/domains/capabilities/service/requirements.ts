import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	bytes,
	requirementProfileData,
	hashRequirementData,
	canonicalRequirementJson,
	type Definition,
	type RequirementProfileData,
	type ProfileDto,
	type ProfilePage,
	type ProfileSnapshot,
	type RequirementCatalog,
	profileSnapshot,
} from "../contracts";
import { validateRequirementSchema } from "./requirement-schema";
export function createRequirements(
	store: SqliteStore,
	register: (db: Database, d: Definition, origin: "user") => void,
) {
	function current(db: Database, id: string): ProfileDto | null {
		const row = db
			.query(
				"SELECT i.*,r.revision,r.definition_hash,r.definition_json FROM capability_items i JOIN capability_revisions r ON r.id=i.active_revision_id WHERE i.kind='requirement' AND i.id=?",
			)
			.get(id) as {
			active_revision_id: string;
			definition_hash: string;
			definition_json: string;
			revision: number;
			generation: number;
			enabled: number;
		} | null;
		if (!row) return null;
		const data = requirementProfileData.parse(
			JSON.parse(row.definition_json).requirementData,
		);
		const state = {
			id,
			activeRevisionId: row.active_revision_id,
			hash: row.definition_hash,
			generation: row.generation,
			enabled: !!row.enabled,
		};
		return {
			id,
			revisionId: row.active_revision_id,
			revision: row.revision,
			hash: row.definition_hash,
			generation: row.generation,
			enabled: !!row.enabled,
			stateToken: hashRequirementData(state),
			data,
		};
	}
	function page(db: Database, cursor: string, limit: number): ProfilePage {
		const ids = db
			.query(
				"SELECT id FROM capability_items WHERE kind='requirement' AND id>? ORDER BY id LIMIT ?",
			)
			.all(cursor, limit + 1) as { id: string }[];
		return {
			items: ids.slice(0, limit).map((r) => current(db, r.id)!),
			nextCursor: ids.length > limit ? ids[limit - 1]!.id : null,
		};
	}
	function catalog(db: Database): RequirementCatalog {
		const ids = db
			.query(
				"SELECT id FROM capability_items WHERE kind='requirement' AND enabled=1 ORDER BY active_revision_id",
			)
			.all() as { id: string }[];
		const snapshots: Record<string, ProfileSnapshot> = {},
			items = ids.map((r, i) => {
				const p = current(db, r.id)!,
					ref = `p${i + 1}`;
				snapshots[ref] = {
					revisionId: p.revisionId,
					hash: p.hash,
					generation: p.generation,
					data: p.data,
				};
				return { ref, title: p.data.title, scope: p.data.scope };
			});
		if (items.length > 32 || bytes(items) > 8192)
			throw new Error("requirement_capacity_exceeded");
		return { items, snapshots };
	}
	function validate(db: Database, snapshots: ProfileSnapshot[]) {
		if (
			snapshots.length > 4 ||
			new Set(snapshots.map((s) => s.revisionId)).size !== snapshots.length
		)
			throw new Error("invalid_requirement_profile");
		for (const raw of snapshots) {
			const s = profileSnapshot.parse(raw),
				id = s.revisionId.slice("requirement:".length).split("@")[0]!,
				p = current(db, id);
			if (
				!p?.enabled ||
				p.revisionId !== s.revisionId ||
				p.hash !== s.hash ||
				p.generation !== s.generation ||
				canonicalRequirementJson(p.data) !== canonicalRequirementJson(s.data)
			)
				throw new Error("requirement_profile_invalidated");
			for (const r of s.data.requirements)
				validateRequirementSchema(r.valueSchema);
		}
	}
	return {
		listRequirementProfiles: (cursor = "", limit = 50) => {
			if (!Number.isInteger(limit) || limit < 1 || limit > 50)
				throw new Error("invalid_capability_limit");
			return store.read((db) => page(db, cursor, limit));
		},
		getRequirementProfile: (id: string) => store.read((db) => current(db, id)),
		async putRequirementProfile(
			id: string,
			token: string | null,
			raw: RequirementProfileData,
		) {
			if (!/^[a-z][a-z0-9._-]{0,100}$/.test(id))
				throw new Error("invalid_requirement_profile");
			const parsed = requirementProfileData.safeParse(raw);
			if (!parsed.success) throw new Error("invalid_requirement_profile");
			const data = JSON.parse(
				canonicalRequirementJson(parsed.data),
			) as RequirementProfileData;
			for (const r of data.requirements)
				validateRequirementSchema(r.valueSchema);
			return store.write((db) => {
				const p = current(db, id);
				if (
					(p ? p.stateToken : null) !== token ||
					(!p && db.query("SELECT 1 FROM capability_items WHERE id=?").get(id))
				)
					throw new Error("requirement_conflict");
				if (
					p &&
					canonicalRequirementJson(p.data) === canonicalRequirementJson(data)
				)
					return p;
				const count = db
					.query(
						"SELECT count(*) AS n FROM capability_items WHERE kind='requirement'",
					)
					.get() as { n: number };
				if (!p && count.n >= 256)
					throw new Error("requirement_capacity_exceeded");
				const rev = db
					.query(
						"SELECT coalesce(max(revision),0)+1 AS n FROM capability_revisions WHERE item_key=?",
					)
					.get(`requirement:${id}`) as { n: number };
				const d: Definition = {
					kind: "requirement",
					id,
					revision: rev.n,
					title: data.title,
					summary: data.scope,
					aliases: [],
					tags: [],
					useWhen: [],
					avoidWhen: [],
					dependencies: [],
					requirementData: data,
				};
				const total = db
					.query(
						"SELECT coalesce(sum(length(CAST(definition_json AS BLOB))),0) AS n FROM capability_revisions WHERE item_key IN (SELECT key FROM capability_items WHERE kind='requirement')",
					)
					.get() as { n: number };
				if (total.n + bytes(d) > 4 * 1024 * 1024)
					throw new Error("requirement_capacity_exceeded");
				db.exec("SAVEPOINT requirement_put");
				try {
					register(db, d, "user");
					catalog(db);
					db.exec("RELEASE requirement_put");
				} catch (e) {
					db.exec("ROLLBACK TO requirement_put");
					db.exec("RELEASE requirement_put");
					throw e;
				}
				return current(db, id)!;
			});
		},
		async setRequirementProfileState(
			id: string,
			token: string,
			enabled: boolean,
		) {
			return store.write((db) => {
				const p = current(db, id);
				if (!p) throw new Error("requirement_not_found");
				if (p.stateToken !== token) throw new Error("requirement_conflict");
				if (p.enabled === enabled) return p;
				db.exec("SAVEPOINT requirement_state");
				try {
					db.query(
						"UPDATE capability_items SET enabled=?,generation=generation+1 WHERE key=?",
					).run(enabled ? 1 : 0, `requirement:${id}`);
					catalog(db);
					db.exec("RELEASE requirement_state");
				} catch (e) {
					db.exec("ROLLBACK TO requirement_state");
					db.exec("RELEASE requirement_state");
					throw e;
				}
				return current(db, id)!;
			});
		},
		requirementCatalogInTransaction: catalog,
		validateRequirementProfilesInTransaction: validate,
		resolveRequirementProfilesInTransaction(
			db: Database,
			c: RequirementCatalog,
			refs: string[],
		) {
			if (
				refs.length > 4 ||
				new Set(refs).size !== refs.length ||
				refs.some((ref) => !Object.hasOwn(c.snapshots, ref))
			)
				throw new Error("requirement_profile_invalidated");
			const selected = refs
				.map((ref) => c.snapshots[ref]!)
				.sort((a, b) => a.revisionId.localeCompare(b.revisionId));
			validate(db, selected);
			return selected;
		},
	};
}
