import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { RecognitionRecord, Connection, Handoff } from "../contracts";
export const migrations: readonly Migration[] = [
	{
		id: "object-recognition/0001-init",
		after: ["queue/0001-init"],
		sql: `CREATE TABLE object_recognition_inputs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,conversation_id TEXT NOT NULL,mime TEXT NOT NULL,bytes BLOB NOT NULL,record_json TEXT NOT NULL,connection_json TEXT NOT NULL,upstream_id TEXT,step INTEGER NOT NULL DEFAULT 0,deadline INTEGER NOT NULL);
CREATE INDEX object_recognition_owner ON object_recognition_inputs(owner,conversation_id);
CREATE TABLE object_recognition_commands(run_id TEXT PRIMARY KEY,owner TEXT NOT NULL,conversation_id TEXT NOT NULL,result_json TEXT NOT NULL);`,
	},
	{
		id: "object-recognition/0002-handoffs",
		after: ["object-recognition/0001-init"],
		sql: `CREATE TABLE object_recognition_handoffs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,conversation_id TEXT NOT NULL,source TEXT NOT NULL,recognition_id TEXT,question TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,deadline INTEGER NOT NULL);
CREATE INDEX object_recognition_handoff_owner ON object_recognition_handoffs(owner,conversation_id,state);`,
	},
	{
		id: "object-recognition/0003-execution-calls",
		after: ["object-recognition/0002-handoffs"],
		sql: "CREATE TABLE object_recognition_execution_commands(call_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,owner TEXT NOT NULL,conversation_id TEXT NOT NULL,result_json TEXT NOT NULL);",
	},
	{
		id: "object-recognition/0004-analyses",
		after: ["object-recognition/0003-execution-calls"],
		sql: `CREATE TABLE object_recognition_analyses(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES object_recognition_inputs(id) ON DELETE CASCADE,owner TEXT NOT NULL,conversation_id TEXT NOT NULL,frame_key INTEGER NOT NULL,record_json TEXT NOT NULL,input_json TEXT NOT NULL,job_id TEXT,connection_id TEXT);
CREATE INDEX object_recognition_analyses_source ON object_recognition_analyses(source_id,frame_key);
CREATE UNIQUE INDEX object_recognition_analyses_active ON object_recognition_analyses(source_id,frame_key) WHERE json_extract(record_json,'$.state') IN ('queued','starting','running','cancelling');`,
	},
];
export type Row = {
	id: string;
	owner: string;
	conversation_id: string;
	mime: string;
	bytes: Uint8Array;
	record_json: string;
	connection_json: string;
	upstream_id: string | null;
	step: number;
	deadline: number;
};
export function row(db: Database, id: string) {
	return db
		.query("SELECT * FROM object_recognition_inputs WHERE id=?")
		.get(id) as Row | null;
}
export function owned(db: Database, id: string, owner: string) {
	const r = row(db, id);
	if (!r || r.owner !== owner) throw new Error("recognition_not_found");
	return r;
}
export function record(
	r: Pick<Row, "record_json" | "upstream_id">,
): RecognitionRecord {
	const v = JSON.parse(r.record_json) as RecognitionRecord;
	return { ...v, canRecheck: !!r.upstream_id && v.state === "failed" };
}
export function patch(
	db: Database,
	id: string,
	change: Partial<RecognitionRecord>,
) {
	const r = row(db, id)!;
	const previous = record(r);
	const v = {
		...previous,
		...change,
		revision: previous.revision + 1,
		updatedAt: Date.now(),
	};
	db.query("UPDATE object_recognition_inputs SET record_json=? WHERE id=?").run(
		JSON.stringify(v),
		id,
	);
	return v;
}

/**
 * Records the capture's LARM save state. It is not part of the analysed source, so the record keeps
 * its revision and its detailed analyses stay valid (`analysis-source.ts` leaves it out of the digest).
 */
export function setCaptureSave(
	db: Database,
	id: string,
	state: NonNullable<RecognitionRecord["captureSave"]>,
) {
	const r = row(db, id)!;
	const recordJson = JSON.stringify({
		...(JSON.parse(r.record_json) as RecognitionRecord),
		captureSave: state,
	});
	db.query("UPDATE object_recognition_inputs SET record_json=? WHERE id=?").run(
		recordJson,
		id,
	);
	return record({ ...r, record_json: recordJson });
}
/** Store only endpoint/revision binding, never decrypted credential. */
export function binding(c: Connection) {
	return JSON.stringify({
		revision: c.revision,
		baseUrl: c.baseUrl,
		credentialVersion: c.credentialVersion,
	});
}
export function list(db: Database, owner: string, conversationId: string) {
	return (
		db
			.query(
				"SELECT record_json,upstream_id FROM object_recognition_inputs WHERE owner=? AND conversation_id=? ORDER BY rowid DESC LIMIT 100",
			)
			.all(owner, conversationId) as Pick<Row, "record_json" | "upstream_id">[]
	).map(record);
}
type HandoffRow = {
	id: string;
	owner: string;
	conversation_id: string;
	source: Handoff["source"];
	recognition_id: string | null;
	question: string;
	state: Handoff["state"];
	created: number;
	deadline: number;
};
function handoffOf(r: HandoffRow): Handoff {
	return {
		id: r.id,
		conversationId: r.conversation_id,
		source: r.source,
		recognitionId: r.recognition_id,
		question: r.question,
		state:
			r.state === "pending" && r.deadline <= Date.now() ? "expired" : r.state,
		deadline: r.deadline,
	};
}
export function insertHandoff(
	db: Database,
	owner: string,
	h: Omit<Handoff, "state">,
) {
	db.query(
		"INSERT INTO object_recognition_handoffs VALUES(?,?,?,?,?,?,'pending',?,?)",
	).run(
		h.id,
		owner,
		h.conversationId,
		h.source,
		h.recognitionId,
		h.question,
		Date.now(),
		h.deadline,
	);
}
export function ownedHandoff(db: Database, id: string, owner: string) {
	const r = db
		.query("SELECT * FROM object_recognition_handoffs WHERE id=? AND owner=?")
		.get(id, owner) as HandoffRow | null;
	if (!r) throw new Error("recognition_handoff_not_found");
	return handoffOf(r);
}
export function pendingHandoffs(
	db: Database,
	owner: string,
	conversationId: string,
) {
	return (
		db
			.query(
				"SELECT * FROM object_recognition_handoffs WHERE owner=? AND conversation_id=? AND state='pending' AND deadline>? ORDER BY created",
			)
			.all(owner, conversationId, Date.now()) as HandoffRow[]
	).map(handoffOf);
}
export function updateHandoff(
	db: Database,
	id: string,
	change: { state: Handoff["state"]; recognitionId?: string },
) {
	db.query(
		"UPDATE object_recognition_handoffs SET state=?,recognition_id=COALESCE(?,recognition_id) WHERE id=?",
	).run(change.state, change.recognitionId ?? null, id);
}
