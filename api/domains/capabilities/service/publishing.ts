import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { artifactPointer } from "../repository";

/**
 * Publication moves (also rollbacks) as compare-and-set: the caller names the revision it saw
 * as published, so two operators cannot silently overwrite each other.
 */
export function createPublishing(
	store: SqliteStore,
	api: {
		publishToolchainRevisionInTransaction: (
			db: Database,
			toolchainId: string,
			revisionId: string,
		) => void;
		publishArtifactRevisionInTransaction: (
			db: Database,
			artifactId: string,
			revisionId: string,
		) => void;
	},
) {
	return {
		/** The highest stored revision of a definition (0 when none): the next one a publisher writes is above it. */
		latestRevisionInTransaction(
			db: Database,
			kind: string,
			id: string,
		): number {
			const row = db
				.query(
					"SELECT MAX(r.revision) AS n FROM capability_revisions r JOIN capability_items i ON i.key=r.item_key WHERE i.kind=? AND i.id=?",
				)
				.get(kind, id) as { n: number | null };
			return row.n ?? 0;
		},
		publishToolchain: (
			toolchainId: string,
			revisionId: string,
			expectedActiveRevisionId: string,
		) =>
			store.write((db) => {
				const row = db
					.query(
						"SELECT active_revision_id a FROM capability_items WHERE key=?",
					)
					.get(`toolchain:${toolchainId}`) as { a: string } | null;
				if (!row) throw new Error("capability_not_found");
				if (row.a !== expectedActiveRevisionId)
					throw new Error("capability_publish_conflict");
				api.publishToolchainRevisionInTransaction(db, toolchainId, revisionId);
				return { activeRevisionId: revisionId };
			}),
		publishArtifact: (
			artifactId: string,
			revisionId: string,
			expectedActiveRevisionId: string | null,
		) =>
			store.write((db) => {
				if (artifactPointer(db, artifactId) !== expectedActiveRevisionId)
					throw new Error("capability_publish_conflict");
				api.publishArtifactRevisionInTransaction(db, artifactId, revisionId);
				return { activeRevisionId: revisionId };
			}),
	};
}
