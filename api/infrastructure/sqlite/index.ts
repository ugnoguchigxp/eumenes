import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	mkdirSync,
	openSync,
	realpathSync,
	statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { flock, LOCK_EX_NB, LOCK_UN } from "../flock";
import { getLogger } from "../logger";

const log = getLogger("sqlite");

function isThenable(value: unknown): boolean {
	return (
		value !== null &&
		(typeof value === "object" || typeof value === "function") &&
		"then" in value &&
		typeof value.then === "function"
	);
}

export class WriterOwnedError extends Error {
	constructor() {
		super("database_writer_owned");
	}
}
/** An applied migration was edited afterwards. Carries the id only, never SQL. */
export class MigrationChecksumError extends Error {
	constructor(public readonly migrationId: string) {
		super(`migration_checksum_mismatch:${migrationId}`);
	}
}
/** The database holds a migration this code does not know (the database is newer than the code). */
export class MigrationUnknownAppliedError extends Error {
	constructor(public readonly migrationId: string) {
		super(`migration_unknown_applied:${migrationId}`);
	}
}
/**
 * A named migration. `id` is "<owner>/<4-digit sequence>[-slug]" and never changes once
 * deployed. `after` lists the migrations that must be applied first; it is mandatory for any
 * migration added after the legacy order was frozen. When omitted, the migration depends on the
 * element before it in the list that was passed (the order the list was written in).
 */
export interface Migration {
	readonly id: string;
	readonly sql: string;
	readonly after?: readonly string[];
}
/**
 * `string` entries are a convenience for throw-away databases in tests: they receive the
 * positional id `adhoc/<4 digits>` and depend on the previous entry. Production code passes
 * `Migration` objects only.
 */
export type MigrationInput = Migration | string;

const adhocId = (index: number) =>
	`adhoc/${String(index + 1).padStart(4, "0")}`;
const sha256 = (sql: string) => createHash("sha256").update(sql).digest("hex");

/**
 * Deterministic topological order: a migration is applied after everything it lists in
 * `after`; among the ready ones the earliest in the given list goes first, so a list that is
 * already a valid order is returned unchanged.
 */
export function orderMigrations(input: readonly MigrationInput[]): Migration[] {
	const list = input.map((entry, i) =>
		typeof entry === "string" ? { id: adhocId(i), sql: entry } : entry,
	);
	const index = new Map<string, number>();
	list.forEach((m, i) => {
		if (!m.id || !m.sql) throw new Error("missing_migration");
		if (index.has(m.id)) throw new Error(`migration_duplicate_id:${m.id}`);
		index.set(m.id, i);
	});
	const deps = list.map((m, i) => {
		const after = m.after ?? (i > 0 ? [list[i - 1]!.id] : []);
		for (const dep of after)
			if (!index.has(dep)) throw new Error(`migration_after_unknown:${m.id}`);
		return after;
	});
	const done = new Set<string>();
	const ordered: Migration[] = [];
	while (ordered.length < list.length) {
		const next = list.findIndex(
			(m, i) => !done.has(m.id) && deps[i]!.every((dep) => done.has(dep)),
		);
		if (next < 0) {
			const stuck = list.find((m) => !done.has(m.id));
			throw new Error(`migration_cycle:${stuck?.id}`);
		}
		done.add(list[next]!.id);
		ordered.push(list[next]!);
	}
	return ordered;
}

/**
 * Moves rows of the old positional `schema_migrations` table into `schema_migrations_v2`.
 * Row N meant "the Nth migration of the frozen legacy order". The old table is left in place.
 */
function importLegacyMigrations(
	db: Database,
	byId: Map<string, Migration>,
	legacyOrder: readonly string[],
) {
	const columns = db.query("PRAGMA table_info(schema_migrations)").all() as {
		name: string;
	}[];
	if (columns.length === 0) return;
	const hasChecksum = columns.some((column) => column.name === "checksum");
	const rows = db
		.query(
			hasChecksum
				? "SELECT id, checksum FROM schema_migrations ORDER BY id"
				: "SELECT id, NULL AS checksum FROM schema_migrations ORDER BY id",
		)
		.all() as { id: number; checksum: string | null }[];
	const now = new Date().toISOString();
	db.transaction(() => {
		const insert = db.query(
			"INSERT INTO schema_migrations_v2 (id, checksum, applied_at) VALUES (?, ?, ?)",
		);
		for (const row of rows) {
			const id = legacyOrder[row.id - 1];
			const known = id === undefined ? undefined : byId.get(id);
			if (id === undefined || !known)
				throw new MigrationUnknownAppliedError(id ?? `legacy/${row.id}`);
			// Rows from before checksums existed trust the current definition once.
			insert.run(id, row.checksum ?? sha256(known.sql), now);
		}
	})();
}
export class WriterBusyError extends Error {
	constructor() {
		super("database_writer_queue_full");
	}
}

type SyncResult<T> = T extends PromiseLike<unknown> ? never : T;

export interface SqliteStore {
	read<T>(operation: (db: Database) => T): T;
	/**
	 * Synchronous read transaction on the readonly reader: every SELECT in the
	 * callback sees one committed snapshot. Never opens a writer; a write
	 * attempted inside fails on the readonly connection.
	 */
	readSnapshot<T>(operation: (db: Database) => SyncResult<T>): T;
	write<T>(operation: (db: Database) => T): Promise<T>;
	/** Serialized writer operation outside a transaction (checkpoint / incremental vacuum only). */
	maintenance?<T>(operation: (db: Database) => T): Promise<T>;
	onCommit(listener: () => void): () => void;
	close(): Promise<void>;
}

/** DB, WAL and SHM are owner-only. A permissive parent directory is reported, not fatal (existing installs). */
function restrictPermissions(canonical: string) {
	for (const file of [canonical, `${canonical}-wal`, `${canonical}-shm`])
		if (existsSync(file)) chmodSync(file, 0o600);
	try {
		if (statSync(dirname(canonical)).mode & 0o077)
			log.warn("sqlite.directory_permissive", {
				reason: "directory_permissive",
			});
	} catch {
		/* directory vanished; opening would already have failed */
	}
}

export function openStore(
	filename: string,
	migrations: readonly MigrationInput[],
	options: {
		incrementalVacuum?: boolean;
		/**
		 * Frozen ids of the old positional scheme (row N of `schema_migrations` is
		 * `legacyOrder[N-1]`). Defaults to the given list's order.
		 */
		legacyOrder?: readonly string[];
	} = {},
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
	if (flock(lockFd, LOCK_EX_NB) !== 0) {
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
		const ordered = orderMigrations(migrations);
		const byId = new Map(ordered.map((m) => [m.id, m]));
		migrationWriter.exec(
			"CREATE TABLE IF NOT EXISTS schema_migrations_v2 (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)",
		);
		const appliedCount = (
			migrationWriter
				.query("SELECT COUNT(*) AS n FROM schema_migrations_v2")
				.get() as { n: number }
		).n;
		if (appliedCount === 0)
			importLegacyMigrations(
				migrationWriter,
				byId,
				options.legacyOrder ?? ordered.map((m) => m.id),
			);
		const applied = new Map(
			(
				migrationWriter
					.query("SELECT id, checksum FROM schema_migrations_v2")
					.all() as { id: string; checksum: string }[]
			).map((x) => [x.id, x.checksum]),
		);
		// A newer database than this code: refuse before touching anything.
		for (const id of applied.keys())
			if (!byId.has(id)) throw new MigrationUnknownAppliedError(id);
		for (const { id, sql } of ordered) {
			const stored = applied.get(id);
			if (stored !== undefined) {
				if (stored !== sha256(sql)) throw new MigrationChecksumError(id);
				continue;
			}
			migrationWriter.transaction(() => {
				migrationWriter.exec(sql);
				migrationWriter
					.query(
						"INSERT INTO schema_migrations_v2 (id, checksum, applied_at) VALUES (?, ?, ?)",
					)
					.run(id, sha256(sql), new Date().toISOString());
			})();
		}
		restrictPermissions(canonical);
		reader = new Database(canonical, { readonly: true });
		reader.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
	} catch (error) {
		reader?.close();
		writer?.close();
		flock(lockFd, LOCK_UN);
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
		readSnapshot: (operation) => {
			if (closing) throw new Error("database_closing");
			return r.transaction(() => {
				const value = operation(r);
				if (isThenable(value)) {
					void Promise.resolve(value).catch(() => {});
					throw new Error("async_snapshot_callback");
				}
				return value;
			})();
		},
		write: (operation) => {
			return serialized(() => {
				const before = changes.get()?.count;
				const result = w.transaction(() => {
					const value = operation(w);
					if (isThenable(value)) {
						void Promise.resolve(value).catch(() => {});
						throw new Error("async_write_callback");
					}
					return value;
				})();
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
		maintenance: (operation) =>
			serialized(() => {
				const value = operation(w);
				if (isThenable(value)) {
					void Promise.resolve(value).catch(() => {});
					throw new Error("async_maintenance_callback");
				}
				return value;
			}),
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
			flock(lockFd, LOCK_UN);
			closeSync(lockFd);
		},
	};
}
