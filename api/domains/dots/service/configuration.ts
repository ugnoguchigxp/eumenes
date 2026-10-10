import type { Database } from "bun:sqlite";
import { randomBytes, createHash } from "node:crypto";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { connectionInput, projectInput } from "../contracts";
import * as repo from "../repository";
export const tokenDigest = (v: string) =>
	createHash("sha256").update(v).digest("hex");
export function createConfiguration(
	store: SqliteStore,
	changed?: (
		db: Database,
		scope: {
			connectionRef?: string;
			projectRef?: string;
			ownershipChanged?: boolean;
		},
	) => void,
) {
	return {
		list() {
			return store.readSnapshot((db) => ({
				connections: (
					db
						.query("SELECT data_json FROM dots_connections ORDER BY id")
						.all() as { data_json: string }[]
				).map(
					(r) =>
						JSON.parse(r.data_json) as NonNullable<
							ReturnType<typeof repo.connection>
						>,
				),
				projects: (
					db
						.query("SELECT data_json FROM dots_projects ORDER BY ref")
						.all() as { data_json: string }[]
				).map(
					(r) =>
						JSON.parse(r.data_json) as NonNullable<
							ReturnType<typeof repo.project>
						>,
				),
			}));
		},
		async configure(raw: unknown) {
			const data = connectionInput.parse(raw);
			return store.write((db) => {
				const previous = repo.connection(db, data.id);
				if ((previous?.revision ?? 0) !== data.expectedRevision)
					throw new Error("dots_conflict");
				if (
					previous?.oauth &&
					(!data.oauth ||
						previous.oauth.issuer !== data.oauth.issuer ||
						previous.oauth.subject !== data.oauth.subject ||
						previous.oauth.resource !== data.oauth.resource)
				)
					throw new Error("dots_owner_immutable");
				if (
					previous &&
					!previous.oauth &&
					data.oauth &&
					db
						.query("SELECT 1 FROM dots_commands WHERE connection_ref=? LIMIT 1")
						.get(data.id)
				)
					throw new Error("dots_owner_immutable");
				if (
					!previous &&
					(
						db.query("SELECT count(*) AS n FROM dots_connections").get() as {
							n: number;
						}
					).n >= 8
				)
					throw new Error("dots_capacity");
				const { expectedRevision, ...fields } = data;
				const connection = { ...fields, revision: expectedRevision + 1 };
				const token = previous ? null : randomBytes(32).toString("hex");
				db.query(
					"INSERT INTO dots_connections VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json",
				).run(data.id, JSON.stringify(connection), tokenDigest(token ?? ""));
				changed?.(db, {
					connectionRef: data.id,
					ownershipChanged: !!previous && !previous.oauth && !!data.oauth,
				});
				return { connection, localToken: token };
			});
		},
		async configureProject(raw: unknown) {
			const data = projectInput.parse(raw);
			return store.write((db) => {
				if (!repo.connection(db, data.connectionRef))
					throw new Error("dots_not_found");
				const old = repo.project(db, data.ref);
				if ((old?.revision ?? 0) !== data.expectedRevision)
					throw new Error("dots_conflict");
				if (old && old.connectionRef !== data.connectionRef)
					throw new Error("dots_conflict");
				if (
					!old &&
					(
						db.query("SELECT count(*) AS n FROM dots_projects").get() as {
							n: number;
						}
					).n >= 64
				)
					throw new Error("dots_capacity");
				const { expectedRevision, ...fields } = data;
				const project = { ...fields, revision: expectedRevision + 1 };
				db.query(
					"INSERT INTO dots_projects VALUES(?,?,?) ON CONFLICT(ref) DO UPDATE SET data_json=excluded.data_json",
				).run(project.ref, project.connectionRef, JSON.stringify(project));
				changed?.(db, { projectRef: data.ref });
				return project;
			});
		},
		authenticateLocal(token: string) {
			return store.readSnapshot((db) => {
				const row = db
					.query("SELECT id FROM dots_connections WHERE local_token_hash=?")
					.get(tokenDigest(token)) as { id: string } | null;
				const c = row ? repo.connection(db, row.id) : null;
				if (!c) throw new Error("dots_permission_denied");
				return c;
			});
		},
	};
}
