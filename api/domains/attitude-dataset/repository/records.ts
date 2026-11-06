import type { Database } from "bun:sqlite";
export type Control = { enabled: number; epoch: number; salt: string };
export type Unit = {
	id: string;
	status: string;
	reason: string | null;
	sample: string | null;
};
export function readControl(db: Database) {
	return db
		.query<Control, []>("SELECT * FROM dataset_control WHERE id=1")
		.get();
}
export function listUnits(db: Database) {
	return db.query<Unit, []>("SELECT * FROM dataset_units ORDER BY id").all();
}
export function recordError(db: Database) {
	return db.exec("UPDATE dataset_errors SET count=count+1 WHERE id=1");
}
export function readErrorCount(db: Database) {
	return db
		.query<{ count: number }, []>("SELECT count FROM dataset_errors WHERE id=1")
		.get();
}
export function countSamples(db: Database) {
	return db
		.query<{ n: number }, []>(
			"SELECT count(*) AS n FROM dataset_units WHERE sample IS NOT NULL",
		)
		.get();
}
export function setEnabled(db: Database, enabled: number) {
	return db
		.query("UPDATE dataset_control SET enabled=?,epoch=epoch+1 WHERE id=1")
		.run(enabled);
}
export function cancelPending(db: Database) {
	return db.exec(
		"UPDATE dataset_units SET status='cancelled',reason=COALESCE(reason,'stopped') WHERE status='pending'",
	);
}
export function countReserved(db: Database) {
	return db
		.query<{ n: number }, []>(
			"SELECT count(*) AS n FROM dataset_units WHERE sample IS NOT NULL OR status='pending'",
		)
		.get();
}
export function reserveUnit(db: Database, id: string) {
	return db
		.query("INSERT OR IGNORE INTO dataset_units(id,status) VALUES(?,'pending')")
		.run(id);
}
export function cancelUnit(db: Database, id: string) {
	return db
		.query(
			"UPDATE dataset_units SET status='cancelled',reason='cancelled' WHERE id=?",
		)
		.run(id);
}
export function cancelUnitWithReason(db: Database, reason: string, id: string) {
	return db
		.query("UPDATE dataset_units SET status='cancelled',reason=? WHERE id=?")
		.run(reason, id);
}
export function listSamples(db: Database) {
	return db
		.query<Unit, []>("SELECT * FROM dataset_units WHERE sample IS NOT NULL")
		.all();
}
export function saveSample(db: Database, sample: string, id: string) {
	return db
		.query("UPDATE dataset_units SET sample=? WHERE id=?")
		.run(sample, id);
}
export function readAdoption(db: Database, id: string) {
	return db
		.query<{ delivery: string }, [string]>(
			"SELECT delivery FROM dataset_adoptions WHERE id=?",
		)
		.get(id);
}
export function settleUnit(
	db: Database,
	status: string,
	reason: string | null,
	sample: string | null,
	id: string,
) {
	return db
		.query("UPDATE dataset_units SET status=?,reason=?,sample=? WHERE id=?")
		.run(status, reason, sample, id);
}
export function disable(db: Database) {
	return db.exec("UPDATE dataset_control SET enabled=0 WHERE id=1");
}
export function failUnit(db: Database, reason: string, id: string) {
	return db
		.query("UPDATE dataset_units SET status='failed',reason=? WHERE id=?")
		.run(reason, id);
}
export function readUnit(db: Database, id: string) {
	return db
		.query<Unit, [string]>("SELECT * FROM dataset_units WHERE id=?")
		.get(id);
}
export function saveAdoption(db: Database, id: string, delivery: string) {
	return db
		.query(
			"INSERT INTO dataset_adoptions(id,delivery) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET delivery=excluded.delivery",
		)
		.run(id, delivery);
}
export function listSamplesOrdered(db: Database) {
	return db
		.query<Unit, []>(
			"SELECT * FROM dataset_units WHERE sample IS NOT NULL ORDER BY id",
		)
		.all();
}
export function recover(db: Database) {
	return db.exec(
		"UPDATE dataset_control SET enabled=0,epoch=epoch+1 WHERE id=1; UPDATE dataset_units SET status='interrupted',reason='restart' WHERE status='pending'",
	);
}
