import type { Database } from "bun:sqlite";
import type {
	BlockerReason,
	KanbanColumn,
	KanbanLabel,
	KanbanReceipt,
} from "./contracts";

export { migrations } from "./migrations";

export type CardRow = {
	id: string;
	revision: number;
	title: string;
	prompt: string;
	column: KanbanColumn;
	label: KanbanLabel | null;
	reason: BlockerReason | null;
	reviewed: boolean;
	commitPushReported: boolean;
	projectId: string;
	claudeSessionId: string | null;
	currentRunId: string | null;
	lastReport: string | null;
	files: string[];
	position: number;
	createdAt: number;
	updatedAt: number;
};

type RawCard = {
	id: string;
	revision: number;
	title: string;
	prompt: string;
	column_name: KanbanColumn;
	label: KanbanLabel | null;
	reason: BlockerReason | null;
	reviewed: number;
	commit_push_reported: number;
	project_id: string;
	claude_session_id: string | null;
	current_run_id: string | null;
	last_report: string | null;
	files_json: string;
	position: number;
	created_at: number;
	updated_at: number;
};

const toCard = (row: RawCard): CardRow => ({
	id: row.id,
	revision: row.revision,
	title: row.title,
	prompt: row.prompt,
	column: row.column_name,
	label: row.label,
	reason: row.reason,
	reviewed: row.reviewed === 1,
	commitPushReported: row.commit_push_reported === 1,
	projectId: row.project_id,
	claudeSessionId: row.claude_session_id,
	currentRunId: row.current_run_id,
	lastReport: row.last_report,
	files: JSON.parse(row.files_json) as string[],
	position: row.position,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
});

export function getCard(db: Database, id: string): CardRow | null {
	const row = db
		.query("SELECT * FROM kanban_cards WHERE id=?")
		.get(id) as RawCard | null;
	return row ? toCard(row) : null;
}

export const allCards = (db: Database): CardRow[] =>
	(
		db
			.query(
				`SELECT * FROM kanban_cards ORDER BY
  CASE column_name WHEN 'todo' THEN 0 WHEN 'running' THEN 1 ELSE 2 END, position, id`,
			)
			.all() as RawCard[]
	).map(toCard);

export const columnIds = (db: Database, column: KanbanColumn): string[] =>
	(
		db
			.query(
				"SELECT id FROM kanban_cards WHERE column_name=? ORDER BY position, id",
			)
			.all(column) as Array<{ id: string }>
	).map((row) => row.id);

export function insertCard(db: Database, card: CardRow) {
	db.query(
		`INSERT INTO kanban_cards(id,revision,title,prompt,column_name,label,reason,reviewed,
 commit_push_reported,project_id,claude_session_id,current_run_id,last_report,files_json,
 position,created_at,updated_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		card.id,
		card.revision,
		card.title,
		card.prompt,
		card.column,
		card.label,
		card.reason,
		card.reviewed ? 1 : 0,
		card.commitPushReported ? 1 : 0,
		card.projectId,
		card.claudeSessionId,
		card.currentRunId,
		card.lastReport,
		JSON.stringify(card.files),
		card.position,
		card.createdAt,
		card.updatedAt,
	);
}

/** Writes the fields an operation may change; the position is set by `placeColumn`. */
export function updateCard(db: Database, card: CardRow) {
	db.query(
		`UPDATE kanban_cards SET revision=?,title=?,prompt=?,column_name=?,label=?,reason=?,
 reviewed=?,commit_push_reported=?,claude_session_id=?,current_run_id=?,last_report=?,
 files_json=?,updated_at=? WHERE id=?`,
	).run(
		card.revision,
		card.title,
		card.prompt,
		card.column,
		card.label,
		card.reason,
		card.reviewed ? 1 : 0,
		card.commitPushReported ? 1 : 0,
		card.claudeSessionId,
		card.currentRunId,
		card.lastReport,
		JSON.stringify(card.files),
		card.updatedAt,
		card.id,
	);
}

export const deleteCard = (db: Database, id: string) =>
	db.query("DELETE FROM kanban_cards WHERE id=?").run(id);

/** Stores the order of one column as positions 0..n-1 (rows that already match are kept). */
export function placeColumn(db: Database, ids: readonly string[]) {
	const update = db.query(
		"UPDATE kanban_cards SET position=? WHERE id=? AND position<>?",
	);
	ids.forEach((id, position) => update.run(position, id, position));
}

export const boardRevision = (db: Database): number =>
	(
		db.query("SELECT revision FROM kanban_board WHERE id=1").get() as {
			revision: number;
		}
	).revision;

export const bumpBoard = (db: Database) =>
	db.query("UPDATE kanban_board SET revision=revision+1 WHERE id=1").run();

export function getReceipt(
	db: Database,
	requestId: string,
): { operation: string; digest: string; receipt: KanbanReceipt } | null {
	const row = db
		.query(
			"SELECT operation,input_digest,receipt_json FROM kanban_receipts WHERE request_id=?",
		)
		.get(requestId) as {
		operation: string;
		input_digest: string;
		receipt_json: string;
	} | null;
	return row
		? {
				operation: row.operation,
				digest: row.input_digest,
				receipt: JSON.parse(row.receipt_json) as KanbanReceipt,
			}
		: null;
}

export function saveReceipt(
	db: Database,
	requestId: string,
	operation: string,
	digest: string,
	receipt: KanbanReceipt,
	createdAt: number,
) {
	db.query(
		"INSERT INTO kanban_receipts(request_id,operation,input_digest,receipt_json,created_at) VALUES(?,?,?,?,?)",
	).run(requestId, operation, digest, JSON.stringify(receipt), createdAt);
}

/** Deletes the receipts saved before `before`; returns how many. */
export const deleteOldReceipts = (db: Database, before: number): number =>
	db.query("DELETE FROM kanban_receipts WHERE created_at<?").run(before)
		.changes;
