import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { OcrRecord, Connection } from "../contracts";
export const migrations: readonly Migration[] = [
	{
		id: "ocr/0001-init",
		after: ["queue/0001-init"],
		sql: `CREATE TABLE ocr_inputs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,conversation_id TEXT NOT NULL,mime TEXT NOT NULL,bytes BLOB NOT NULL,record_json TEXT NOT NULL,connection_json TEXT NOT NULL,upstream_id TEXT,step INTEGER NOT NULL DEFAULT 0,deadline INTEGER NOT NULL);
CREATE INDEX ocr_owner ON ocr_inputs(owner,conversation_id);
CREATE TABLE ocr_commands(request_id TEXT PRIMARY KEY,owner TEXT NOT NULL,conversation_id TEXT NOT NULL,operation TEXT NOT NULL,target_id TEXT,result_json TEXT NOT NULL);
`,
	},
	{
		id: "ocr/0002-corrections",
		after: ["ocr/0001-init"],
		sql: `CREATE TABLE ocr_corrections(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES ocr_inputs(id) ON DELETE CASCADE,owner TEXT NOT NULL,conversation_id TEXT NOT NULL,frame_key INTEGER NOT NULL,source_revision INTEGER NOT NULL,source_digest TEXT NOT NULL,record_json TEXT NOT NULL,bindings_json TEXT NOT NULL,job_id TEXT,inference_request_id TEXT);
CREATE INDEX ocr_corrections_source ON ocr_corrections(source_id,frame_key,id);
CREATE UNIQUE INDEX ocr_corrections_active ON ocr_corrections(source_id,frame_key) WHERE json_extract(record_json,'$.state') IN ('queued','running','cancelling');
CREATE TABLE ocr_correction_preference(source_id TEXT NOT NULL REFERENCES ocr_inputs(id) ON DELETE CASCADE,frame_key INTEGER NOT NULL,preferred_id TEXT,revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(source_id,frame_key));`,
	},
	{
		id: "ocr/0003-qr",
		after: ["ocr/0002-corrections"],
		sql: `CREATE TABLE ocr_qr(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES ocr_inputs(id) ON DELETE CASCADE,owner TEXT NOT NULL,conversation_id TEXT NOT NULL,frame_key INTEGER NOT NULL,source_revision INTEGER NOT NULL,record_json TEXT NOT NULL,job_id TEXT);
CREATE INDEX ocr_qr_source ON ocr_qr(source_id,frame_key,source_revision);
CREATE UNIQUE INDEX ocr_qr_active ON ocr_qr(source_id,frame_key) WHERE json_extract(record_json,'$.state') IN ('queued','running','cancelling');`,
	},
	{
		id: "ocr/0004-analyses",
		after: ["ocr/0003-qr"],
		sql: `CREATE TABLE ocr_analyses(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES ocr_inputs(id) ON DELETE CASCADE,owner TEXT NOT NULL,conversation_id TEXT NOT NULL,frame_key INTEGER NOT NULL,record_json TEXT NOT NULL,input_json TEXT NOT NULL,job_id TEXT,connection_id TEXT);
CREATE INDEX ocr_analyses_source ON ocr_analyses(source_id,frame_key);
CREATE UNIQUE INDEX ocr_analyses_active ON ocr_analyses(source_id,frame_key) WHERE json_extract(record_json,'$.state') IN ('queued','starting','running','cancelling');`,
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
	return db.query("SELECT * FROM ocr_inputs WHERE id=?").get(id) as Row | null;
}
export function owned(db: Database, id: string, owner: string) {
	const r = row(db, id);
	if (!r || r.owner !== owner) throw new Error("ocr_not_found");
	return r;
}
export function connectionMatches(
	bindingJson: string,
	current: Connection | null,
) {
	if (!current) return false;
	const bound = JSON.parse(bindingJson) as Pick<
		Connection,
		"revision" | "baseUrl" | "credentialVersion"
	>;
	return (
		bound.revision === current.revision &&
		bound.baseUrl === current.baseUrl &&
		bound.credentialVersion === current.credentialVersion
	);
}
export function record(
	r: Pick<Row, "record_json" | "upstream_id"> &
		Partial<Pick<Row, "connection_json">>,
	current?: Connection | null,
): OcrRecord {
	const v = JSON.parse(r.record_json) as OcrRecord;
	return {
		...v,
		canRecheck:
			!!r.upstream_id &&
			v.state === "failed" &&
			v.errorCode !== "ocr_connection_changed" &&
			(current === undefined ||
				(!!r.connection_json && connectionMatches(r.connection_json, current))),
	};
}
export function patch(db: Database, id: string, change: Partial<OcrRecord>) {
	const r = row(db, id)!;
	const previous = JSON.parse(r.record_json) as OcrRecord;
	const v = {
		...previous,
		...change,
		canRecheck: undefined,
		revision: previous.revision + 1,
		updatedAt: Date.now(),
	};
	const serialized = JSON.stringify(v);
	db.query("UPDATE ocr_inputs SET record_json=? WHERE id=?").run(
		serialized,
		id,
	);
	return record({ ...r, record_json: serialized });
}
/** Store only endpoint/revision binding, never decrypted credential. */
export function binding(c: Connection) {
	return JSON.stringify({
		revision: c.revision,
		baseUrl: c.baseUrl,
		credentialVersion: c.credentialVersion,
	});
}
export function activeCount(
	db: Database,
	owner: string,
	conversationId: string,
) {
	return (
		db
			.query(
				"SELECT count(*) AS n FROM ocr_inputs WHERE owner=? AND conversation_id=? AND json_extract(record_json,'$.state') IN ('queued','starting','running','cancelling')",
			)
			.get(owner, conversationId) as { n: number }
	).n;
}
export function list(
	db: Database,
	owner: string,
	conversationId: string,
	current?: Connection | null,
) {
	return (
		db
			.query(
				"SELECT record_json,upstream_id,connection_json FROM ocr_inputs WHERE owner=? AND conversation_id=? ORDER BY rowid DESC LIMIT 100",
			)
			.all(owner, conversationId) as Pick<
			Row,
			"record_json" | "upstream_id" | "connection_json"
		>[]
	).map((r) => record(r, current));
}
