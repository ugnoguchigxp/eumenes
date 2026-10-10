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

/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{ id: "attitude-dataset/0001-init", sql: migration },
];
