import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type {
	RequestReason,
	RequestState,
	RequestTarget,
	SessionMode,
	SessionOwner,
} from "../contracts";

/**
 * The durable outbox of requests for Claude Code. A request is saved inside the caller's writer
 * transaction and only sent after it committed; every later change is a guarded update
 * (`expected state -> new state`), so a final state is never overwritten.
 */
const migration = `
CREATE TABLE terminal_requests (
 id TEXT PRIMARY KEY,
 digest TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','sending','delivered','started','completed','interrupted','ended','unknown','cancelled')),
 reason TEXT,
 owner TEXT NOT NULL,
 target TEXT NOT NULL CHECK(target IN ('new','conversation','current')),
 mode TEXT NOT NULL CHECK(mode IN ('work','commit')),
 project_id TEXT NOT NULL,
 task TEXT NOT NULL,
 prompt TEXT NOT NULL,
 origin TEXT NOT NULL CHECK(origin IN ('board','conversation')),
 conversation_id TEXT,
 claude_session_id TEXT,
 exclusive_group TEXT,
 terminal_session_id TEXT,
 terminal_run INTEGER,
 prompt_id TEXT,
 last_report TEXT,
 files_json TEXT NOT NULL DEFAULT '[]',
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX terminal_requests_state ON terminal_requests(state);
CREATE INDEX terminal_requests_session ON terminal_requests(terminal_session_id, state);
`;

/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{
		id: "terminals/0001-requests",
		sql: migration,
		after: ["queue/0001-init"],
	},
];

/** A saved request, including the text to send. */
export type RequestRow = {
	id: string;
	digest: string;
	state: RequestState;
	reason?: RequestReason;
	owner: SessionOwner;
	target: RequestTarget;
	mode: SessionMode;
	projectId: string;
	task: string;
	prompt: string;
	origin: "board" | "conversation" | "execution";
	conversationId?: string;
	claudeSessionId?: string;
	exclusiveGroup?: "kanban";
	terminalSessionId?: string;
	terminalRun?: number;
	promptId?: string;
	lastReport?: string;
	files: string[];
	createdAt: string;
	updatedAt: string;
};

type Row = Record<string, unknown>;
const text = <T extends string>(value: unknown) =>
	typeof value === "string" ? (value as T) : undefined;

function map(r: Row): RequestRow {
	return {
		id: r.id as string,
		digest: r.digest as string,
		state: r.state as RequestState,
		...(r.reason ? { reason: r.reason as RequestReason } : {}),
		owner: r.owner as SessionOwner,
		target: r.target as RequestTarget,
		mode: r.mode as SessionMode,
		projectId: r.project_id as string,
		task: r.task as string,
		prompt: r.prompt as string,
		origin: r.origin as RequestRow["origin"],
		...(r.conversation_id ? { conversationId: text(r.conversation_id)! } : {}),
		...(r.claude_session_id
			? { claudeSessionId: text(r.claude_session_id)! }
			: {}),
		...(r.exclusive_group ? { exclusiveGroup: "kanban" as const } : {}),
		...(r.terminal_session_id
			? { terminalSessionId: text(r.terminal_session_id)! }
			: {}),
		...(typeof r.terminal_run === "number"
			? { terminalRun: r.terminal_run }
			: {}),
		...(r.prompt_id ? { promptId: text(r.prompt_id)! } : {}),
		...(r.last_report ? { lastReport: text(r.last_report)! } : {}),
		files: JSON.parse(r.files_json as string) as string[],
		createdAt: r.created_at as string,
		updatedAt: r.updated_at as string,
	};
}

export type NewRequest = Omit<
	RequestRow,
	| "state"
	| "reason"
	| "terminalSessionId"
	| "terminalRun"
	| "promptId"
	| "lastReport"
	| "files"
	| "updatedAt"
>;

export function insert(db: Database, request: NewRequest) {
	db.query(
		`INSERT INTO terminal_requests (id, digest, state, owner, target, mode, project_id, task, prompt, origin, conversation_id, claude_session_id, exclusive_group, created_at, updated_at)
		 VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		request.id,
		request.digest,
		request.owner,
		request.target,
		request.mode,
		request.projectId,
		request.task,
		request.prompt,
		request.origin,
		request.conversationId ?? null,
		request.claudeSessionId ?? null,
		request.exclusiveGroup ?? null,
		request.createdAt,
		request.createdAt,
	);
}

export function get(db: Database, id: string): RequestRow | null {
	const row = db
		.query("SELECT * FROM terminal_requests WHERE id = ?")
		.get(id) as Row | null;
	return row ? map(row) : null;
}

/** Queued requests, oldest first. */
export function queued(db: Database): RequestRow[] {
	return (
		db
			.query(
				"SELECT * FROM terminal_requests WHERE state = 'queued' ORDER BY rowid",
			)
			.all() as Row[]
	).map(map);
}

export const hasQueued = (db: Database) =>
	db
		.query(
			"SELECT 1 AS one FROM terminal_requests WHERE state = 'queued' LIMIT 1",
		)
		.get() !== null;

/** Requests that are not final, oldest first (startup recovery). */
export function open(db: Database): RequestRow[] {
	return (
		db
			.query(
				"SELECT * FROM terminal_requests WHERE state IN ('queued','sending','delivered','started') ORDER BY rowid",
			)
			.all() as Row[]
	).map(map);
}

export type Change = {
	state: RequestState;
	reason?: RequestReason;
	terminalSessionId?: string;
	terminalRun?: number;
	promptId?: string;
	lastReport?: string;
	files?: readonly string[];
};

/**
 * Moves a request to a new state only while it is in one of the `from` states. Returns whether
 * it moved: false means another writer got there first and nothing changed.
 */
export function transition(
	db: Database,
	id: string,
	from: readonly RequestState[],
	change: Change,
	at: string,
): boolean {
	const result = db
		.query(
			`UPDATE terminal_requests SET
			   state = ?, reason = ?,
			   terminal_session_id = COALESCE(?, terminal_session_id),
			   terminal_run = COALESCE(?, terminal_run),
			   prompt_id = COALESCE(?, prompt_id),
			   last_report = COALESCE(?, last_report),
			   files_json = COALESCE(?, files_json),
			   updated_at = ?
			 WHERE id = ? AND state IN (${from.map(() => "?").join(",")})`,
		)
		.run(
			change.state,
			change.reason ?? null,
			change.terminalSessionId ?? null,
			change.terminalRun ?? null,
			change.promptId ?? null,
			change.lastReport ?? null,
			change.files ? JSON.stringify(change.files) : null,
			at,
			id,
			...from,
		);
	return result.changes > 0;
}

const FINAL_STATES = "'completed','interrupted','ended','unknown','cancelled'";

/**
 * Deletes final requests last changed before `cutoff`, then all but the newest `keep` final
 * ones. Open requests are never touched. Returns how many rows were deleted.
 */
export function pruneFinal(db: Database, cutoff: string, keep: number): number {
	const aged = db
		.query(
			`DELETE FROM terminal_requests WHERE state IN (${FINAL_STATES}) AND updated_at < ?`,
		)
		.run(cutoff).changes;
	const surplus = db
		.query(
			`DELETE FROM terminal_requests WHERE state IN (${FINAL_STATES}) AND rowid NOT IN (
			   SELECT rowid FROM terminal_requests WHERE state IN (${FINAL_STATES})
			   ORDER BY updated_at DESC, rowid DESC LIMIT ?)`,
		)
		.run(keep).changes;
	return aged + surplus;
}
