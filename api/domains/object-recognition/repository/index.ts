import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { RecognitionRecord, Connection } from "../contracts";
export const migrations: readonly Migration[] = [
	{
		id: "object-recognition/0001-init",
		after: ["queue/0001-init"],
		sql: `CREATE TABLE object_recognition_inputs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,conversation_id TEXT NOT NULL,mime TEXT NOT NULL,bytes BLOB NOT NULL,record_json TEXT NOT NULL,connection_json TEXT NOT NULL,upstream_id TEXT,step INTEGER NOT NULL DEFAULT 0,deadline INTEGER NOT NULL);
CREATE INDEX object_recognition_owner ON object_recognition_inputs(owner,conversation_id);
CREATE TABLE object_recognition_commands(run_id TEXT PRIMARY KEY,owner TEXT NOT NULL,conversation_id TEXT NOT NULL,result_json TEXT NOT NULL);`,
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
