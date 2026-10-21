import type { Database } from "bun:sqlite";

/** References only: definitions and requests keep their existing owners. */
export const retainedToolchainsMigration = `
CREATE TABLE dialogue_toolchain_state (
 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
 epoch INTEGER NOT NULL DEFAULT 0, last_use_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE dialogue_retained_toolchains (
 conversation_id TEXT NOT NULL REFERENCES conversations(id), revision_id TEXT NOT NULL,
 source_run_id TEXT NOT NULL REFERENCES dialogue_runs(id), selection_id TEXT NOT NULL,
 message_id TEXT NOT NULL REFERENCES messages(id), source_revision TEXT NOT NULL,
 use_seq INTEGER NOT NULL, PRIMARY KEY(conversation_id, revision_id)
);
`;
export type RetainedReference = {
	revision_id: string;
	source_run_id: string;
	selection_id: string;
	message_id: string;
	source_revision: string;
	use_seq: number;
};
export function retainedState(db: Database, conversationId: string) {
	return (
		(db
			.query(
				"SELECT epoch,last_use_seq FROM dialogue_toolchain_state WHERE conversation_id=?",
			)
			.get(conversationId) as {
			epoch: number;
			last_use_seq: number;
		} | null) ?? { epoch: 0, last_use_seq: 0 }
	);
}
export function retainedReferences(db: Database, conversationId: string) {
	return db
		.query(
			"SELECT revision_id,source_run_id,selection_id,message_id,source_revision,use_seq FROM dialogue_retained_toolchains WHERE conversation_id=? ORDER BY use_seq DESC,revision_id",
		)
		.all(conversationId) as RetainedReference[];
}
export function removeRetained(
	db: Database,
	conversationId: string,
	revisionId: string,
) {
	db.query(
		"DELETE FROM dialogue_retained_toolchains WHERE conversation_id=? AND revision_id=?",
	).run(conversationId, revisionId);
}
export function resetRetained(db: Database, conversationId: string) {
	db.query(
		"INSERT INTO dialogue_toolchain_state(conversation_id,epoch) SELECT ?1,1 WHERE EXISTS(SELECT 1 FROM dialogue_runs WHERE conversation_id=?1) ON CONFLICT(conversation_id) DO UPDATE SET epoch=epoch+1",
	).run(conversationId);
	db.query(
		"DELETE FROM dialogue_retained_toolchains WHERE conversation_id=?",
	).run(conversationId);
}
export function runSequence(db: Database, runId: string) {
	return (
		db.query("SELECT seq FROM dialogue_runs WHERE id=?").get(runId) as {
			seq: number;
		}
	).seq;
}
export function saveRetained(
	db: Database,
	conversationId: string,
	ref: RetainedReference,
) {
	db.query(
		"INSERT INTO dialogue_toolchain_state(conversation_id,last_use_seq) VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET last_use_seq=excluded.last_use_seq",
	).run(conversationId, ref.use_seq);
	db.query(`INSERT INTO dialogue_retained_toolchains(conversation_id,revision_id,source_run_id,selection_id,message_id,source_revision,use_seq) VALUES(?,?,?,?,?,?,?)
 ON CONFLICT(conversation_id,revision_id) DO UPDATE SET source_run_id=excluded.source_run_id,selection_id=excluded.selection_id,message_id=excluded.message_id,source_revision=excluded.source_revision,use_seq=excluded.use_seq`).run(
		conversationId,
		ref.revision_id,
		ref.source_run_id,
		ref.selection_id,
		ref.message_id,
		ref.source_revision,
		ref.use_seq,
	);
}
