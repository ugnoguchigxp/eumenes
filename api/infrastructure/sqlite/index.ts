import { dlopen, FFIType } from "bun:ffi";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fchmodSync,
	existsSync,
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
/** An applied migration was edited afterwards. Carries the id only, never SQL. */
export class MigrationChecksumError extends Error {
	constructor(public readonly migrationId: number) {
		super("migration_checksum_mismatch");
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
	/** Serialized writer operation outside a transaction (checkpoint / incremental vacuum only). */
	maintenance?<T>(operation: (db: Database) => T): Promise<T>;
	onCommit(listener: () => void): () => void;
	close(): Promise<void>;
}

export function openStore(
	filename: string,
	migrations: readonly string[],
	options: { incrementalVacuum?: boolean } = {},
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
		const newDatabase = !existsSync(canonical);
		const migrationWriter = new Database(canonical, { create: true });
		writer = migrationWriter;
		if (newDatabase && options.incrementalVacuum)
			migrationWriter.exec("PRAGMA auto_vacuum=INCREMENTAL");
		migrationWriter.exec(
			"PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
		);
		migrationWriter.exec(
			"CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY)",
		);
		const columns = migrationWriter
			.query("PRAGMA table_info(schema_migrations)")
			.all() as { name: string }[];
		if (!columns.some((column) => column.name === "checksum"))
			migrationWriter.exec(
				"ALTER TABLE schema_migrations ADD COLUMN checksum TEXT",
			);
		const checksum = (sql: string) =>
			createHash("sha256").update(sql).digest("hex");
		const applied = new Map(
			(
				migrationWriter
					.query("SELECT id, checksum FROM schema_migrations")
					.all() as { id: number; checksum: string | null }[]
			).map((x) => [x.id, x.checksum]),
		);
		for (let i = 0; i < migrations.length; i++) {
			const id = i + 1;
			const sql = migrations[i];
			if (!sql) throw new Error("missing_migration");
			if (applied.has(id)) {
				const stored = applied.get(id);
				// Rows from before checksums existed trust the current definition once.
				if (stored == null)
					migrationWriter
						.query("UPDATE schema_migrations SET checksum=? WHERE id=?")
						.run(checksum(sql), id);
				else if (stored !== checksum(sql)) throw new MigrationChecksumError(id);
				continue;
			}
			migrationWriter.transaction(() => {
				migrationWriter.exec(sql);
				migrationWriter
					.query("INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)")
					.run(id, checksum(sql));
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
	const listeners = new Set<() => void>();
	const changes = w.query<{ count: number }, []>(
		"SELECT total_changes() AS count",
	);
	function serialized<T>(operation: () => T): Promise<T> {
		if (closing) return Promise.reject(new Error("database_closing"));
		if (pending >= 64) return Promise.reject(new WriterBusyError());
		pending++;
		const task = tail.then(operation);
		tail = task
			.catch(() => {})
			.finally(() => {
				pending--;
			});
		return task;
	}
	return {
		read: (operation) => {
			if (closing) throw new Error("database_closing");
			return operation(r);
		},
		write: (operation) => {
			return serialized(() => {
				const before = changes.get()?.count;
				const result = w.transaction(() => operation(w))();
				// Only committed mutations notify. Idle worker scans and rollbacks do not.
				if (changes.get()?.count !== before)
					for (const listener of listeners) {
						try {
							listener();
						} catch {
							// Notification failures cannot turn a committed write into a failure.
						}
					}
				return result;
			});
		},
		maintenance: (operation) => serialized(() => operation(w)),
		onCommit(listener) {
			if (closing) throw new Error("database_closing");
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async close() {
			if (closing) return;
			closing = true;
			await tail;
			listeners.clear();
			r.close();
			w.close();
			libc.symbols.flock(lockFd, LOCK_UN);
			closeSync(lockFd);
		},
	};
}
