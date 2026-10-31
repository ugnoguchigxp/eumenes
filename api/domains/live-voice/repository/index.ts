import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { LiveSnapshot, LiveSegment, LiveNotice } from "../contracts";

export const migrations: readonly Migration[] = [
	{
		id: "live-voice/0001-init",
		after: ["conversation/0001-init"],
		sql: `
CREATE TABLE live_voice_sessions(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,conversation_id TEXT NOT NULL,status TEXT NOT NULL,muted INTEGER NOT NULL,test INTEGER NOT NULL,started_at TEXT NOT NULL,error TEXT,usage_confirmed INTEGER NOT NULL DEFAULT 0,usage TEXT,connection_id TEXT NOT NULL,connection_epoch INTEGER NOT NULL,input_version INTEGER NOT NULL DEFAULT 0);
CREATE INDEX live_voice_conversation ON live_voice_sessions(conversation_id,started_at);
CREATE UNIQUE INDEX live_voice_active ON live_voice_sessions(conversation_id) WHERE status IN ('connecting','active','closing');
CREATE TABLE live_voice_segments(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES live_voice_sessions(id),speaker TEXT NOT NULL,text TEXT NOT NULL,start_ms REAL NOT NULL,end_ms REAL NOT NULL,message_id TEXT,seq INTEGER NOT NULL);
CREATE TABLE live_voice_fragments(session_id TEXT NOT NULL,seq INTEGER NOT NULL,segment_id TEXT NOT NULL REFERENCES live_voice_segments(id),delta TEXT NOT NULL,start_ms REAL NOT NULL,end_ms REAL NOT NULL,PRIMARY KEY(session_id,seq));
CREATE TABLE live_voice_delegations(session_id TEXT NOT NULL,delegation_id TEXT NOT NULL,input_version INTEGER NOT NULL,run_id TEXT,state TEXT NOT NULL,PRIMARY KEY(session_id,delegation_id));
CREATE TABLE live_voice_runs(run_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,input_version INTEGER NOT NULL);
CREATE TABLE live_voice_outputs(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,run_id TEXT,text TEXT NOT NULL,kind TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0);
CREATE TABLE live_voice_notices(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,text TEXT NOT NULL,kind TEXT NOT NULL,displayed INTEGER NOT NULL DEFAULT 0);
`,
	},
];

export type SessionRow = {
	id: string;
	request_id: string;
	conversation_id: string;
	status: LiveSnapshot["status"];
	muted: number;
	test: number;
	started_at: string;
	error: string | null;
	usage_confirmed: number;
	connection_id: string;
	connection_epoch: number;
	input_version: number;
};
export const session = (db: Database, id: string) =>
	db
		.query("SELECT * FROM live_voice_sessions WHERE id=?")
		.get(id) as SessionRow | null;
export const active = (db: Database, conversationId: string) =>
	db
		.query(
			"SELECT * FROM live_voice_sessions WHERE conversation_id=? AND status IN ('connecting','active','closing')",
		)
		.get(conversationId) as SessionRow | null;
export const latest = (db: Database, conversationId: string) =>
	db
		.query(
			"SELECT * FROM live_voice_sessions WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1",
		)
		.get(conversationId) as SessionRow | null;
export function snapshot(db: Database, id: string): LiveSnapshot | null {
	const row = session(db, id);
	if (!row) return null;
	const segments = (
		db
			.query(
				"SELECT id,speaker,text,start_ms AS startMs,end_ms AS endMs,message_id AS messageId FROM live_voice_segments WHERE session_id=? ORDER BY seq DESC LIMIT 32",
			)
			.all(id) as LiveSegment[]
	).reverse();
	const notices = (
		db
			.query(
				"SELECT id,text,kind,displayed FROM live_voice_notices WHERE session_id=? ORDER BY displayed, rowid DESC LIMIT 16",
			)
			.all(id) as Array<Omit<LiveNotice, "displayed"> & { displayed: number }>
	).map((n) => ({ ...n, displayed: !!n.displayed }));
	return {
		id,
		conversationId: row.conversation_id,
		status: row.status,
		muted: !!row.muted,
		test: !!row.test,
		startedAt: row.started_at,
		error: row.error,
		usageConfirmed: !!row.usage_confirmed,
		segments,
		notices,
	};
}
