import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";

export const collaborationStateMigration: Migration = {
	id: "dialogue/0039-collaboration-state",
	after: ["dialogue/0038-resource-attached"],
	sql: `CREATE TABLE dialogue_collaboration_states (
 session_id TEXT PRIMARY KEY REFERENCES dialogue_specialist_sessions(id),
 body TEXT NOT NULL, source_revision INTEGER NOT NULL, orphaned TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE dialogue_collaboration_sources (
 session_id TEXT NOT NULL REFERENCES dialogue_specialist_sessions(id),
 ref TEXT NOT NULL, message_id TEXT NOT NULL, digest TEXT NOT NULL, active INTEGER NOT NULL,
 PRIMARY KEY(session_id,ref)
);
CREATE INDEX dialogue_collaboration_source_message ON dialogue_collaboration_sources(message_id);
CREATE TABLE dialogue_collaboration_receipts (
 operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES dialogue_specialist_sessions(id),
 epoch INTEGER NOT NULL, digest TEXT NOT NULL, revision INTEGER NOT NULL
);`,
};

export type StateRow = {
	body: string;
	source_revision: number;
	orphaned: string;
};
export type SourceRow = {
	ref: string;
	message_id: string;
	digest: string;
	active: number;
};
export const collaborationState = (db: Database, session: string) =>
	db
		.query<StateRow, [string]>(
			"SELECT body,source_revision,orphaned FROM dialogue_collaboration_states WHERE session_id=?",
		)
		.get(session);
export const collaborationSources = (db: Database, session: string) =>
	db
		.query<SourceRow, [string]>(
			"SELECT ref,message_id,digest,active FROM dialogue_collaboration_sources WHERE session_id=? ORDER BY rowid",
		)
		.all(session);
