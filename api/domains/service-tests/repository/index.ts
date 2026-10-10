import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { ServiceRun } from "../contracts";
import type { LarmTestTarget, TestArtifact } from "../../larm";
export const migration = `CREATE TABLE service_test_runs(id TEXT PRIMARY KEY,request_key TEXT NOT NULL UNIQUE,input_hash TEXT NOT NULL,created INTEGER NOT NULL,data TEXT NOT NULL);`;
export interface RunRecord extends ServiceRun {
	target?: LarmTestTarget;
	artifact?: TestArtifact;
}
export function readRuns(db: Database): RunRecord[] {
	return (
		db
			.query(
				"SELECT data FROM service_test_runs ORDER BY created DESC LIMIT 50",
			)
			.all() as { data: string }[]
	).map((r) => JSON.parse(r.data) as RunRecord);
}
export function readRun(db: Database, id: string): RunRecord | null {
	const r = db
		.query("SELECT data FROM service_test_runs WHERE id=?")
		.get(id) as { data: string } | null;
	return r ? (JSON.parse(r.data) as RunRecord) : null;
}
export function updateRun(
	db: Database,
	id: string,
	change: Partial<RunRecord>,
) {
	const prior = readRun(db, id);
	if (!prior) throw new Error("invalid_test_run");
	const next = { ...prior, ...change };
	db.query("UPDATE service_test_runs SET data=? WHERE id=?").run(
		JSON.stringify(next),
		id,
	);
	return next;
}

/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{ id: "service-tests/0001-init", sql: migration },
];
