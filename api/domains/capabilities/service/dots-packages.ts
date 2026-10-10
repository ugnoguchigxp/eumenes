import type { Database } from "bun:sqlite";
import { dotsPackageInput } from "../contracts/dots";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { hash, bytes, type Definition } from "../contracts";
export function createDotsPackages(
	store: SqliteStore,
	register: (db: Database, d: Definition, origin: "user") => void,
) {
	function read(db: Database, id: string) {
		const row = db
			.query(
				"SELECT i.enabled,i.generation,r.definition_json,r.definition_hash FROM capability_items i JOIN capability_revisions r ON r.id=i.active_revision_id WHERE i.kind='package' AND i.origin='user' AND i.id=?",
			)
			.get(id) as {
			enabled: number;
			generation: number;
			definition_json: string;
			definition_hash: string;
		} | null;
		if (!row) return null;
		const d = JSON.parse(row.definition_json) as Definition;
		const body = (ref: string) =>
			JSON.parse(
				(
					db
						.query(
							"SELECT definition_json FROM capability_revisions WHERE id=?",
						)
						.get(ref) as { definition_json: string }
				).definition_json,
			) as Definition;
		return {
			id,
			revision: d.revision,
			revisionId: `package:${id}@${d.revision}`,
			stateToken: hash([row.definition_hash, row.generation, row.enabled]),
			title: d.title,
			summary: d.summary,
			enabled: !!row.enabled,
			profile: body(d.profileRevisionId!).body!,
			skills: d.requiredSkillRevisionIds!.map((ref) => {
				const s = body(ref);
				return { title: s.title, body: s.body! };
			}),
		};
	}
	return {
		listDotsPackages() {
			return store.readSnapshot((db) => ({
				items: (
					db
						.query(
							"SELECT id FROM capability_items WHERE kind='package' AND origin='user' AND id LIKE 'dots.user.%' ORDER BY id LIMIT 32",
						)
						.all() as { id: string }[]
				).map((r) => read(db, r.id)!),
			}));
		},
		async putDotsPackage(raw: unknown) {
			const data = dotsPackageInput.parse(raw);
			return store.write((db) => {
				if (
					(
						db
							.query(
								"SELECT coalesce(sum(length(CAST(r.definition_json AS BLOB))),0) n FROM capability_revisions r JOIN capability_items i ON i.key=r.item_key WHERE i.origin='user'",
							)
							.get() as { n: number }
					).n +
						bytes(data) * 3 >
					67108864
				)
					throw new Error("reference_capacity");
				const old = read(db, data.id);
				if ((old?.stateToken ?? null) !== data.expectedToken)
					throw new Error("capability_revision_conflict");
				if (
					!old &&
					(
						db
							.query(
								"SELECT count(*) n FROM capability_items WHERE kind='package' AND origin='user' AND id LIKE 'dots.user.%'",
							)
							.get() as { n: number }
					).n >= 32
				)
					throw new Error("reference_capacity");
				if (bytes([data.profile, ...data.skills.map((s) => s.body)]) > 14000)
					throw new Error("required_context_overflow");
				const revision = (old?.revision ?? 0) + 1,
					common = {
						revision,
						aliases: [],
						tags: [],
						useWhen: [],
						avoidWhen: [],
						dependencies: [],
					};
				const profileId = `${data.id}.role`,
					skills = data.skills.map((_, i) => `${data.id}.skill${i + 1}`);
				register(
					db,
					{
						...common,
						kind: "profile",
						id: profileId,
						title: data.title,
						summary: data.summary,
						body: data.profile,
					},
					"user",
				);
				for (const [i, s] of data.skills.entries())
					register(
						db,
						{
							...common,
							kind: "skill",
							id: skills[i]!,
							title: s.title,
							summary: s.title,
							body: s.body,
						},
						"user",
					);
				const profileRevisionId = `profile:${profileId}@${revision}`,
					requiredSkillRevisionIds = skills.map(
						(id) => `skill:${id}@${revision}`,
					),
					toolRevisionIds = ["tool:dots.coordinate@1"];
				register(
					db,
					{
						...common,
						kind: "package",
						id: data.id,
						title: data.title,
						summary: data.summary,
						backend: "dots",
						schemaKey: "dotsDelegation",
						profileRevisionId,
						requiredSkillRevisionIds,
						toolRevisionIds,
						dependencies: [
							profileRevisionId,
							...requiredSkillRevisionIds,
							...toolRevisionIds,
						],
					},
					"user",
				);
				db.query("UPDATE capability_items SET enabled=? WHERE key=?").run(
					data.enabled ? 1 : 0,
					`package:${data.id}`,
				);
				return read(db, data.id)!;
			});
		},
	};
}
