import type { Database } from "bun:sqlite";
export const workMigration = `
CREATE TABLE dots_work_settings(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,data_json TEXT NOT NULL);
CREATE TABLE dots_work_operations(id TEXT PRIMARY KEY,digest TEXT NOT NULL,origin_json TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at INTEGER NOT NULL);
`;
export function workOperation(db: Database, id: string) {
	return db
		.query(
			"SELECT digest,origin_json,receipt_json FROM dots_work_operations WHERE id=?",
		)
		.get(id) as {
		digest: string;
		origin_json: string;
		receipt_json: string;
	} | null;
}
export function putWorkOperation(
	db: Database,
	input: {
		id: string;
		digest: string;
		origin: string;
		receipt: unknown;
		now: number;
	},
) {
	const wire = JSON.stringify(input.receipt),
		size = Buffer.byteLength(wire);
	if (size > 65536) throw new Error("dots_capacity");
	db.query("DELETE FROM dots_work_operations WHERE created_at<?").run(
		input.now - 30 * 86400000,
	);
	if (
		(
			db.query("SELECT count(*) AS n FROM dots_work_operations").get() as {
				n: number;
			}
		).n >= 10000
	)
		throw new Error("dots_capacity");
	if (
		(
			db
				.query(
					"SELECT coalesce(sum(length(CAST(receipt_json AS BLOB))+length(CAST(origin_json AS BLOB))),0) AS n FROM dots_work_operations",
				)
				.get() as { n: number }
		).n +
			size +
			Buffer.byteLength(input.origin) >
		32 * 1024 * 1024
	)
		throw new Error("dots_capacity");
	db.query("INSERT INTO dots_work_operations VALUES(?,?,?,?,?)").run(
		input.id,
		input.digest,
		input.origin,
		wire,
		input.now,
	);
}
export function purgeWorkOperations(db: Database, taskId: string) {
	db.query(
		"DELETE FROM dots_work_operations WHERE json_extract(receipt_json,'$.value.taskId')=? OR EXISTS(SELECT 1 FROM json_each(receipt_json,'$.value.items') WHERE json_extract(value,'$.ref')=?)",
	).run(taskId, taskId);
}
