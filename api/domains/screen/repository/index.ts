import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { ScreenAction, ScreenCommand, ScreenStatus } from "../contracts";

export const migrations: readonly Migration[] = [
	{
		id: "screen/0001-commands",
		// A command names its conversation; it runs after the conversation tables (no foreign key).
		after: ["conversation/0001-init"],
		sql: `
CREATE TABLE screen_commands (
  seq INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL, uri TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('open','play')), adapter_ref TEXT NOT NULL, target_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','done','blocked','unavailable','expired')),
  created_at TEXT NOT NULL, settled_at TEXT);
CREATE INDEX screen_commands_pending ON screen_commands(conversation_id, status, seq);
`,
	},
];

type Row = {
	seq: number;
	conversation_id: string;
	uri: string;
	action: ScreenAction;
	adapter_ref: string;
	target_ref: string;
	status: ScreenStatus;
	created_at: string;
	settled_at: string | null;
};

const toCommand = (row: Row): ScreenCommand => ({
	seq: row.seq,
	conversationId: row.conversation_id,
	uri: row.uri,
	action: row.action,
	adapterRef: row.adapter_ref,
	targetRef: row.target_ref,
	status: row.status,
	createdAt: row.created_at,
	settledAt: row.settled_at,
});

export function insertCommand(
	db: Database,
	command: Omit<ScreenCommand, "seq" | "status" | "settledAt">,
): ScreenCommand {
	const row = db
		.query(
			`INSERT INTO screen_commands (conversation_id, uri, action, adapter_ref, target_ref, status, created_at)
VALUES (?,?,?,?,?,'pending',?) RETURNING *`,
		)
		.get(
			command.conversationId,
			command.uri,
			command.action,
			command.adapterRef,
			command.targetRef,
			command.createdAt,
		) as Row;
	return toCommand(row);
}

export function getCommand(db: Database, seq: number): ScreenCommand | null {
	const row = db
		.query("SELECT * FROM screen_commands WHERE seq = ?")
		.get(seq) as Row | null;
	return row ? toCommand(row) : null;
}

/** Pending commands newer than `afterSeq` that were created at or after `notBefore`, oldest first. */
export function pendingCommands(
	db: Database,
	conversationId: string,
	afterSeq: number,
	notBefore: string,
): ScreenCommand[] {
	return (
		db
			.query(
				`SELECT * FROM screen_commands
WHERE conversation_id = ? AND seq > ? AND status = 'pending' AND created_at >= ? ORDER BY seq`,
			)
			.all(conversationId, afterSeq, notBefore) as Row[]
	).map(toCommand);
}

/** Pending commands created before `cutoff`, the ones that expire. */
export function staleCommands(db: Database, cutoff: string): ScreenCommand[] {
	return (
		db
			.query(
				"SELECT * FROM screen_commands WHERE status = 'pending' AND created_at < ? ORDER BY seq",
			)
			.all(cutoff) as Row[]
	).map(toCommand);
}

/** Settles a pending command; false when it was settled already. */
export function settleCommand(
	db: Database,
	seq: number,
	status: Exclude<ScreenStatus, "pending">,
	settledAt: string,
): boolean {
	return (
		db
			.query(
				"UPDATE screen_commands SET status = ?, settled_at = ? WHERE seq = ? AND status = 'pending'",
			)
			.run(status, settledAt, seq).changes > 0
	);
}
