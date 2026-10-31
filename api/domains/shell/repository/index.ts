import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { ShellRun, RunState } from "../contracts";

export const migrations: readonly Migration[] = [
	{
		id: "shell/0001-runs",
		after: ["queue/0001-init"],
		sql: `
CREATE TABLE shell_runs (
 id TEXT PRIMARY KEY, digest TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','running','completed','timed_out','cancelled','unknown')),
 reason TEXT, command TEXT NOT NULL, task TEXT NOT NULL, project_id TEXT NOT NULL,
 timeout_seconds INTEGER NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('conversation','execution')),
 conversation_id TEXT, session_id TEXT, exit_code INTEGER, output_tail TEXT NOT NULL DEFAULT '',
 output_truncated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX shell_runs_state ON shell_runs(state);
`,
	},
	{
		id: "shell/0002-approval",
		after: ["shell/0001-runs"],
		sql: `
CREATE TABLE shell_runs_v2 (
 id TEXT PRIMARY KEY, digest TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('awaiting_approval','queued','running','completed','timed_out','cancelled','unknown')),
 reason TEXT, command TEXT NOT NULL, task TEXT NOT NULL, project_id TEXT NOT NULL,
 timeout_seconds INTEGER NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('conversation','execution')),
 conversation_id TEXT, session_id TEXT, exit_code INTEGER, output_tail TEXT NOT NULL DEFAULT '',
 output_truncated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, updated_at TEXT NOT NULL
);
INSERT INTO shell_runs_v2 (id,digest,state,reason,command,task,project_id,timeout_seconds,origin,conversation_id,session_id,exit_code,output_tail,output_truncated,created_at,started_at,ended_at,updated_at)
 SELECT id,digest,state,reason,command,task,project_id,timeout_seconds,origin,conversation_id,session_id,exit_code,output_tail,output_truncated,created_at,started_at,ended_at,updated_at FROM shell_runs;
DROP TABLE shell_runs;
ALTER TABLE shell_runs_v2 RENAME TO shell_runs;
CREATE INDEX shell_runs_state ON shell_runs(state);
`,
	},
];
function map(r: Record<string, unknown>): ShellRun {
	return {
		id: String(r.id),
		digest: String(r.digest),
		state: r.state as RunState,
		command: String(r.command),
		task: String(r.task),
		projectId: String(r.project_id),
		timeoutSeconds: Number(r.timeout_seconds),
		origin: r.origin as ShellRun["origin"],
		output: String(r.output_tail),
		outputTruncated: !!r.output_truncated,
		createdAt: String(r.created_at),
		updatedAt: String(r.updated_at),
		...(r.reason ? { reason: r.reason as ShellRun["reason"] } : {}),
		...(r.conversation_id ? { conversationId: String(r.conversation_id) } : {}),
		...(r.session_id ? { sessionId: String(r.session_id) } : {}),
		...(r.started_at
			? {
					startedAt: String(r.started_at),
					exitCode: r.exit_code as number | null,
				}
			: {}),
		...(r.ended_at ? { endedAt: String(r.ended_at) } : {}),
	};
}
export function get(db: Database, id: string): ShellRun | null {
	const r = db.query("SELECT * FROM shell_runs WHERE id = ?").get(id) as Record<
		string,
		unknown
	> | null;
	return r ? map(r) : null;
}
export function list(db: Database, openOnly = false, limit = 2000): ShellRun[] {
	return (
		db
			.query(
				`SELECT * FROM shell_runs ${openOnly ? "WHERE state IN ('awaiting_approval','queued','running')" : ""} ORDER BY rowid ${openOnly ? "ASC" : "DESC"} LIMIT ?`,
			)
			.all(openOnly ? -1 : limit) as Record<string, unknown>[]
	).map(map);
}
export function insert(db: Database, r: ShellRun) {
	db.query(
		`INSERT INTO shell_runs (id,digest,state,command,task,project_id,timeout_seconds,origin,conversation_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		r.id,
		r.digest,
		r.state,
		r.command,
		r.task,
		r.projectId,
		r.timeoutSeconds,
		r.origin,
		r.conversationId ?? null,
		r.createdAt,
		r.updatedAt,
	);
}
export function transition(
	db: Database,
	id: string,
	from: RunState[],
	r: Partial<ShellRun> & { state: RunState; updatedAt: string },
) {
	return (
		db
			.query(
				`UPDATE shell_runs SET state=?, reason=?, session_id=COALESCE(?,session_id), exit_code=?, output_tail=COALESCE(?,output_tail), output_truncated=COALESCE(?,output_truncated), started_at=COALESCE(?,started_at), ended_at=COALESCE(?,ended_at), updated_at=? WHERE id=? AND state IN (${from.map(() => "?").join(",")})`,
			)
			.run(
				r.state,
				r.reason ?? null,
				r.sessionId ?? null,
				r.exitCode ?? null,
				r.output ?? null,
				r.outputTruncated === undefined ? null : Number(r.outputTruncated),
				r.startedAt ?? null,
				r.endedAt ?? null,
				r.updatedAt,
				id,
				...from,
			).changes > 0
	);
}
export function prune(db: Database, now: Date) {
	const cutoff = new Date(now.getTime() - 30 * 86400_000).toISOString();
	const a = db
		.query(
			"DELETE FROM shell_runs WHERE state NOT IN ('awaiting_approval','queued','running') AND updated_at < ?",
		)
		.run(cutoff).changes;
	return (
		a +
		db
			.query(
				"DELETE FROM shell_runs WHERE state NOT IN ('awaiting_approval','queued','running') AND rowid NOT IN (SELECT rowid FROM shell_runs WHERE state NOT IN ('awaiting_approval','queued','running') ORDER BY updated_at DESC,rowid DESC LIMIT 2000)",
			)
			.run().changes
	);
}
