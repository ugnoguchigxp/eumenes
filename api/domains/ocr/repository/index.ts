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
