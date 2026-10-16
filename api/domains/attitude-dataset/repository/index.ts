import { mkdirSync, openSync, fchmodSync, closeSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { openStore, type Migration } from "../../../infrastructure/sqlite";

/** Set the database mode before SQLite creates its WAL/SHM sidecars. */
export function openAttitudeStore(path: string) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const fd = openSync(path, "a", 0o600);
	try {
		fchmodSync(fd, 0o600);
	} finally {
		closeSync(fd);
	}
	for (const suffix of ["-wal", "-shm"]) {
		try {
			chmodSync(path + suffix, 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return openStore(path, migrations);
}

export const migration = `
CREATE TABLE dataset_control (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, epoch INTEGER NOT NULL, salt TEXT NOT NULL);
INSERT INTO dataset_control VALUES(1,0,0,lower(hex(randomblob(32))));
CREATE TABLE dataset_units (id TEXT PRIMARY KEY, status TEXT NOT NULL, reason TEXT, sample TEXT);
CREATE TABLE dataset_adoptions (id TEXT PRIMARY KEY, delivery TEXT NOT NULL);
CREATE TABLE dataset_errors (id INTEGER PRIMARY KEY CHECK(id=1), count INTEGER NOT NULL);
INSERT INTO dataset_errors VALUES(1,0);
`;

/** Delivery sources were named after classifier models; store the contract names instead. */
const neutralSource = (json: string, path: string) =>
	`${json}=json_set(${json},'${path}',CASE json_extract(${json},'${path}') WHEN 'ruri' THEN 'scored' ELSE 'system-one' END) WHERE json_extract(${json},'${path}') IN ('laya','ruri')`;
export const neutralSourceMigration = `
UPDATE dataset_adoptions SET ${neutralSource("delivery", "$.source")};
UPDATE dataset_units SET ${neutralSource("sample", "$.adopted.source")};
UPDATE dataset_units SET ${neutralSource("sample", "$.selected_delivery.source")};
UPDATE dataset_units SET reason='invalid-or-unscored' WHERE reason='invalid-or-non-ruri';
`;

/** Named migrations of this domain; the SQL above is frozen once deployed. */
const migrations: readonly Migration[] = [
	{ id: "attitude-dataset/0001-init", sql: migration },
	{ id: "attitude-dataset/0002-neutral-source", sql: neutralSourceMigration },
];
