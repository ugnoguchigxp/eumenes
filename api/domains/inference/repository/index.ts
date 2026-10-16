import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { Purpose, Settings } from "../../settings/contracts";
export const migration = `
CREATE TABLE inference_requests (id TEXT PRIMARY KEY,subject TEXT NOT NULL,purpose TEXT NOT NULL,snapshot TEXT NOT NULL,deadline INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',UNIQUE(subject,purpose));
CREATE TABLE inference_attempts (id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES inference_requests(id),source TEXT NOT NULL,connection_id TEXT,resource_id TEXT,model TEXT,status TEXT NOT NULL,reason TEXT,started INTEGER NOT NULL,ended INTEGER,accepted INTEGER NOT NULL DEFAULT 0,input_tokens INTEGER,output_tokens INTEGER);
CREATE TABLE inference_probes (id TEXT PRIMARY KEY,target TEXT NOT NULL,status TEXT NOT NULL,error TEXT,revision INTEGER NOT NULL,created INTEGER NOT NULL);
`;
export const parentsMigration = `ALTER TABLE inference_requests ADD COLUMN parents TEXT NOT NULL DEFAULT '[]';`;
export const diagnosticsMigration = `ALTER TABLE inference_attempts ADD COLUMN provider_details TEXT NOT NULL DEFAULT '[]';`;
export const controlMigration = `
ALTER TABLE inference_requests ADD COLUMN mode TEXT NOT NULL DEFAULT 'answer';
ALTER TABLE inference_requests ADD COLUMN output_limit INTEGER;
ALTER TABLE inference_requests ADD COLUMN context_policy TEXT NOT NULL DEFAULT 'legacy';
`;
export const backgroundControlMigration = `CREATE TABLE inference_background_controls (
 request_id TEXT PRIMARY KEY REFERENCES inference_requests(id), binding TEXT NOT NULL
);`;
export interface RequestRow {
	controlEngine: "larm" | "codex";
	controlPolicyRequestId: string | null;
	id: string;
	subject: string;
	purpose: Purpose;
	snapshot: Settings;
	deadline: number;
	status: string;
	parents: string[];
	mode: "answer" | "control";
	outputLimit: number | null;
	contextPolicy: "legacy" | "exact";
	/** The control output schema is enforced as a strict provider schema. */
	structuredOutput: boolean;
}
export function get(db: Database, id: string): RequestRow | null {
	const row = db
		.query("SELECT * FROM inference_requests WHERE id=?")
		.get(id) as
		| (Omit<RequestRow, "snapshot" | "parents"> & {
				snapshot: string;
				parents: string;
				output_limit?: number | null;
				context_policy?: "legacy" | "exact";
				control_engine?: "larm" | "codex";
				control_policy_request_id?: string | null;
				structured_output?: number;
		  })
		| null;
	return row
		? {
				...row,
				snapshot: JSON.parse(row.snapshot) as Settings,
				parents: JSON.parse(row.parents) as string[],
				mode: row.mode ?? "answer",
				outputLimit: row.output_limit ?? null,
				contextPolicy: row.context_policy ?? "legacy",
				controlEngine: row.control_engine ?? "larm",
				controlPolicyRequestId: row.control_policy_request_id ?? null,
				structuredOutput: row.structured_output === 1,
			}
		: null;
}

/** Pin the host-selected provider when the control is first captured. */
export function bindControlEngine(db: Database, id: string, engine?: "codex") {
	const row = get(db, id)!;
	if (
		(row.mode === "control" || !engine) &&
		row.controlEngine !== (engine ?? "larm")
	)
		throw new Error("control_engine_conflict");
	if (engine)
		db.query(
			"UPDATE inference_requests SET control_engine=? WHERE id=? AND status='pending'",
		).run(engine, id);
}

/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{ id: "inference/0001-init", sql: migration },
	{ id: "inference/0002-parents", sql: parentsMigration },
	{ id: "inference/0003-diagnostics", sql: diagnosticsMigration },
	{ id: "inference/0004-control", sql: controlMigration },
	{ id: "inference/0005-background-control", sql: backgroundControlMigration },
	{
		id: "inference/0006-control-engine",
		after: ["inference/0005-background-control"],
		sql: "ALTER TABLE inference_requests ADD COLUMN control_engine TEXT NOT NULL DEFAULT 'larm' CHECK(control_engine IN ('larm','codex_luna'));",
	},
	{
		id: "inference/0007-control-policy-binding",
		sql: "ALTER TABLE inference_requests ADD COLUMN control_policy_request_id TEXT;",
		after: ["inference/0006-control-engine"],
	},
	{
		id: "inference/0008-structured-output",
		sql: "ALTER TABLE inference_requests ADD COLUMN structured_output INTEGER NOT NULL DEFAULT 0 CHECK(structured_output IN (0,1));",
		after: ["inference/0007-control-policy-binding"],
	},
	{
		// Per call: the session lifetime it ran with, the task it belongs to, the billing path and agent session it used,
		// the references (conversation message ids, memory item ids) an agent attempt was built from, and the prompt-cache usage and cost the provider reported.
		id: "inference/0009-agent-sessions",
		after: ["inference/0008-structured-output"],
		sql: `ALTER TABLE inference_attempts ADD COLUMN session_role TEXT CHECK(session_role IN ('main','subagent','auxiliary'));
ALTER TABLE inference_attempts ADD COLUMN task_id TEXT;
ALTER TABLE inference_attempts ADD COLUMN billing_path TEXT;
ALTER TABLE inference_attempts ADD COLUMN agent_session_id TEXT;
ALTER TABLE inference_attempts ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE inference_attempts ADD COLUMN cache_creation_tokens INTEGER;
ALTER TABLE inference_attempts ADD COLUMN cost_usd REAL;
CREATE TABLE inference_agent_sessions (
	id TEXT PRIMARY KEY,
	role TEXT NOT NULL CHECK(role IN ('main','subagent')),
	task_id TEXT,
	connection_id TEXT NOT NULL,
	auth TEXT NOT NULL CHECK(auth IN ('subscription','api-key')),
	model TEXT NOT NULL,
	learned_context_window INTEGER,
	created INTEGER NOT NULL,
	updated INTEGER NOT NULL
);
CREATE UNIQUE INDEX inference_agent_sessions_main ON inference_agent_sessions(connection_id, auth, model) WHERE role='main';
CREATE UNIQUE INDEX inference_agent_sessions_task ON inference_agent_sessions(task_id, connection_id, auth, model) WHERE role='subagent';`,
	},
	{
		// Keep 0009 byte-for-byte as deployed. Revocable attempt references were added later.
		id: "inference/0010-attempt-refs",
		after: ["inference/0009-agent-sessions"],
		sql: `ALTER TABLE inference_attempts ADD COLUMN refs TEXT;
CREATE INDEX inference_attempts_revocable ON inference_attempts(status, request_id) WHERE refs IS NOT NULL AND accepted=0;`,
	},
	{
		// The CHECK on the old column cannot admit the model-neutral engine name: replace the column.
		id: "inference/0011-control-engine-codex",
		after: ["inference/0010-attempt-refs"],
		sql: `ALTER TABLE inference_requests ADD COLUMN control_engine_next TEXT NOT NULL DEFAULT 'larm' CHECK(control_engine_next IN ('larm','codex'));
UPDATE inference_requests SET control_engine_next=CASE WHEN control_engine='larm' THEN 'larm' ELSE 'codex' END;
ALTER TABLE inference_requests DROP COLUMN control_engine;
ALTER TABLE inference_requests RENAME COLUMN control_engine_next TO control_engine;`,
	},
];
