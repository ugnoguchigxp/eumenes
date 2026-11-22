import type { Database } from "bun:sqlite";
import type { Migration } from "../../infrastructure/sqlite";
import type { Grant, Parent, Question } from "./state";

export const migrations: readonly Migration[] = [
	{
		id: "development-supervision/0001-work",
		after: ["queue/0001-init"],
		sql: `
CREATE TABLE development_supervision_work(
 id TEXT PRIMARY KEY,
 run_id TEXT NOT NULL UNIQUE,
 conversation_id TEXT NOT NULL,
 workspace_ref TEXT NOT NULL,
 pending INTEGER NOT NULL,
 forgotten INTEGER NOT NULL,
 data TEXT NOT NULL
);
CREATE INDEX development_supervision_pending ON development_supervision_work(pending);
CREATE INDEX development_supervision_workspace ON development_supervision_work(workspace_ref, conversation_id);
CREATE TABLE development_supervision_grants(
 id TEXT PRIMARY KEY,
 parent_id TEXT REFERENCES development_supervision_work(id) NOT NULL,
 operation_id TEXT NOT NULL UNIQUE,
 work_id TEXT UNIQUE,
 data TEXT NOT NULL
);
CREATE INDEX development_supervision_grants_parent ON development_supervision_grants(parent_id);
CREATE TABLE development_supervision_questions(
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 parent_id TEXT REFERENCES development_supervision_work(id) NOT NULL,
 grant_ref TEXT REFERENCES development_supervision_grants(id) NOT NULL,
 child_question_id TEXT NOT NULL,
 data TEXT NOT NULL,
 UNIQUE(grant_ref,child_question_id)
);
CREATE INDEX development_supervision_questions_fifo ON development_supervision_questions(parent_id,seq);
CREATE TABLE development_supervision_board_revision(
 id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL
);
INSERT INTO development_supervision_board_revision VALUES (1,0);
CREATE TABLE development_supervision_controls(
 id TEXT PRIMARY KEY,
 parent_id TEXT REFERENCES development_supervision_work(id) NOT NULL,
 digest TEXT NOT NULL
);`,
	},
];

function decode<T>(row: { data: string } | null): T | null {
	return row ? (JSON.parse(row.data) as T) : null;
}

export function parentOf(db: Database, id: string) {
	return decode<Parent>(
		db
			.query<{ data: string }, [string]>(
				"SELECT data FROM development_supervision_work WHERE id=?",
			)
			.get(id),
	);
}

export function parentOfRun(db: Database, runId: string) {
	return decode<Parent>(
		db
			.query<{ data: string }, [string]>(
				"SELECT data FROM development_supervision_work WHERE run_id=?",
			)
			.get(runId),
	);
}

export function parents(
	db: Database,
	filter: {
		pending?: boolean;
		conversationId?: string;
		workspaceRef?: string;
	} = {},
) {
	return db
		.query<
			{ data: string },
			{
				$pending: number;
				$conversation: string | null;
				$workspace: string | null;
			}
		>(
			`SELECT data FROM development_supervision_work
		 WHERE (($pending=1 AND pending=1) OR ($pending=0 AND forgotten=0))
		 AND ($conversation IS NULL OR conversation_id=$conversation)
		 AND ($workspace IS NULL OR workspace_ref=$workspace) ORDER BY rowid`,
		)
		.all({
			$pending: Number(filter.pending ?? false),
			$conversation: filter.conversationId ?? null,
			$workspace: filter.workspaceRef ?? null,
		})
		.map((row) => JSON.parse(row.data) as Parent);
}

export function saveParent(db: Database, parent: Parent, pending: boolean) {
	db.query(
		`INSERT INTO development_supervision_work VALUES (?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET pending=excluded.pending, forgotten=excluded.forgotten,data=excluded.data`,
	).run(
		parent.id,
		parent.source.runId,
		parent.source.conversationId,
		parent.workspace.workspaceRef,
		Number(pending),
		Number(parent.forgotten),
		JSON.stringify(parent),
	);
}

export function grantOf(db: Database, id: string) {
	return decode<Grant>(
		db
			.query<{ data: string }, [string]>(
				"SELECT data FROM development_supervision_grants WHERE id=?",
			)
			.get(id),
	);
}

export function grantsOf(db: Database, id: string) {
	return db
		.query<{ data: string }, [string]>(
			"SELECT data FROM development_supervision_grants WHERE parent_id=? ORDER BY rowid",
		)
		.all(id)
		.map((row) => JSON.parse(row.data) as Grant);
}

export function saveGrant(db: Database, grant: Grant) {
	db.query(
		`INSERT INTO development_supervision_grants VALUES (?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET work_id=excluded.work_id,data=excluded.data`,
	).run(
		grant.source.delegation.grantRef,
		grant.source.delegation.parentWorkId,
		grant.operationId,
		grant.workId,
		JSON.stringify(grant),
	);
}

export function questionsOf(db: Database, parentId: string) {
	return db
		.query<{ data: string }, [string]>(
			"SELECT data FROM development_supervision_questions WHERE parent_id=? ORDER BY seq",
		)
		.all(parentId)
		.map((row) => JSON.parse(row.data) as Question);
}

export function saveQuestion(db: Database, question: Question) {
	db.query(
		`INSERT INTO development_supervision_questions(id,parent_id,grant_ref,child_question_id,data)
		VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
	).run(
		question.id,
		question.parentId,
		question.grantRef,
		question.childQuestionId,
		JSON.stringify(question),
	);
}

export function operationOf(db: Database, id: string) {
	return db
		.query<{ parent_id: string; digest: string }, [string]>(
			"SELECT parent_id,digest FROM development_supervision_controls WHERE id=?",
		)
		.get(id);
}

export function saveOperation(
	db: Database,
	id: string,
	parentId: string,
	digest: string,
) {
	db.query("INSERT INTO development_supervision_controls VALUES (?,?,?)").run(
		id,
		parentId,
		digest,
	);
}

export function boardRevision(db: Database) {
	return db
		.query<{ revision: number }, []>(
			"SELECT revision FROM development_supervision_board_revision WHERE id=1",
		)
		.get()!.revision;
}

export function touchBoard(db: Database) {
	db.run(
		"UPDATE development_supervision_board_revision SET revision=revision+1 WHERE id=1",
	);
}

export function eraseChildRecords(db: Database, id: string) {
	db.query(
		"DELETE FROM development_supervision_questions WHERE parent_id=?",
	).run(id);
	db.query("DELETE FROM development_supervision_grants WHERE parent_id=?").run(
		id,
	);
}
