import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getLogger } from "../logger";

const log = getLogger("sqlite");

/** Snapshots kept next to the database; older ones are pruned after a new one is taken. */
export const PRE_MIGRATION_BACKUPS_KEPT = 3;

/** The existing database fails SQLite's own consistency check; migrating it would only hide damage. */
export class DatabaseIntegrityError extends Error {
	constructor() {
		super("database_integrity_check_failed");
	}
}

function backupPrefix(canonical: string) {
	return `${basename(canonical)}.pre-migration-`;
}

function pruneBackups(canonical: string, keep: number) {
	const prefix = backupPrefix(canonical);
	const dir = dirname(canonical);
	const stale = readdirSync(dir)
		.filter((name) => name.startsWith(prefix) && name.endsWith(".bak"))
		.sort()
		.reverse()
		.slice(keep);
	for (const name of stale) {
		try {
			unlinkSync(join(dir, name));
		} catch {
			log.warn("sqlite.backup_prune_failed", { reason: "unlink_failed" });
		}
	}
}

/**
 * Runs `PRAGMA integrity_check` and then writes a consistent copy (`VACUUM INTO`) of an
 * existing database next to it, before pending migrations change the schema. Returns the
 * backup path. Throws `DatabaseIntegrityError` when the check does not report `ok`.
 */
export function backupBeforeMigration(
	db: Database,
	canonical: string,
	options: { keep?: number; now?: () => Date } = {},
): string {
	const rows = db.query("PRAGMA integrity_check").all() as Record<
		string,
		unknown
	>[];
	if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") {
		log.error("sqlite.integrity_check_failed", {
			reason: "integrity_check_failed",
		});
		throw new DatabaseIntegrityError();
	}
	const stamp = (options.now ?? (() => new Date()))()
		.toISOString()
		.replace(/\D/g, "");
	let target = join(
		dirname(canonical),
		`${backupPrefix(canonical)}${stamp}.bak`,
	);
	for (let n = 1; existsSync(target); n++)
		target = join(
			dirname(canonical),
			`${backupPrefix(canonical)}${stamp}-${n}.bak`,
		);
	// Create the copy private from the start; chmod alone would leave a window.
	const mask = process.umask(0o077);
	try {
		db.query("VACUUM INTO ?").run(target);
	} finally {
		process.umask(mask);
	}
	chmodSync(target, 0o600);
	pruneBackups(canonical, options.keep ?? PRE_MIGRATION_BACKUPS_KEPT);
	log.info("sqlite.pre_migration_backup", { reason: "pending_migrations" });
	return target;
}
