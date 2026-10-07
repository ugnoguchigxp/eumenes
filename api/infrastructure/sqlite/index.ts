import { dlopen, FFIType } from "bun:ffi";
import { Database } from "bun:sqlite";
import {
	closeSync,
	constants,
	fchmodSync,
	mkdirSync,
	openSync,
	realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const libc = dlopen("/usr/lib/libSystem.B.dylib", {
	flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});
const LOCK_EX_NB = 2 | 4;
const LOCK_UN = 8;

export class WriterOwnedError extends Error {
	constructor() {
		super("database_writer_owned");
	}
}
export class WriterBusyError extends Error {
	constructor() {
		super("database_writer_queue_full");
	}
}

export interface SqliteStore {
	read<T>(operation: (db: Database) => T): T;
	write<T>(operation: (db: Database) => T): Promise<T>;
	close(): Promise<void>;
}

export function openStore(
	filename: string,
	migrations: readonly string[],
): SqliteStore {
	if (filename === ":memory:")
		throw new Error("persistent_database_path_required");
	const requested = resolve(filename);
	mkdirSync(dirname(requested), { recursive: true, mode: 0o700 });
	const canonical = join(realpathSync(dirname(requested)), basename(requested));
	const lockFd = openSync(
		`${canonical}.owner.lock`,
		constants.O_CREAT | constants.O_RDWR,
		0o600,
	);
	fchmodSync(lockFd, 0o600);
	if (libc.symbols.flock(lockFd, LOCK_EX_NB) !== 0) {
		closeSync(lockFd);
		throw new WriterOwnedError();
	}
	let writer: Database | undefined;
	let reader: Database | undefined;
	try {
		const migrationWriter = new Database(canonical, { create: true });
		writer = migrationWriter;
		migrationWriter.exec(
			"PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
		);
		migrationWriter.exec(
			"CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY)",
		);
		const applied = new Set(
			(
				migrationWriter.query("SELECT id FROM schema_migrations").all() as {
					id: number;
				}[]
			).map((x) => x.id),
		);
		for (let i = 0; i < migrations.length; i++) {
			if (applied.has(i + 1)) continue;
			const sql = migrations[i];
			if (!sql) throw new Error("missing_migration");
			migrationWriter.transaction(() => {
				migrationWriter.exec(sql);
				migrationWriter
					.query("INSERT INTO schema_migrations (id) VALUES (?)")
					.run(i + 1);
			})();
		}
		reader = new Database(canonical, { readonly: true });
		reader.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
	} catch (error) {
		reader?.close();
		writer?.close();
		libc.symbols.flock(lockFd, LOCK_UN);
		closeSync(lockFd);
		throw error;
	}
	const w = writer;
	const r = reader;
	let tail: Promise<unknown> = Promise.resolve();
	let pending = 0;
	let closing = false;
	return {
		read: (operation) => {
			if (closing) throw new Error("database_closing");
			return operation(r);
		},
		write: (operation) => {
			if (closing) return Promise.reject(new Error("database_closing"));
			if (pending >= 64) return Promise.reject(new WriterBusyError());
			pending++;
			const task = tail.then(() => w.transaction(() => operation(w))());
			tail = task
				.catch(() => {})
				.finally(() => {
					pending--;
				});
			return task;
		},
		async close() {
			if (closing) return;
			closing = true;
			await tail;
			r.close();
			w.close();
			libc.symbols.flock(lockFd, LOCK_UN);
			closeSync(lockFd);
		},
	};
}
