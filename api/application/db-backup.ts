import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { loadProcessConfig } from "../infrastructure/config";
import { openStore } from "../infrastructure/sqlite";
import { backupOnRequest } from "../infrastructure/sqlite/pre-migration-backup";
import { legacyOrder, migrations } from "./migrations";

/** Explicit offline backup; does not start services or apply pending migrations. */
export async function backupDatabaseOnRequest(filename: string) {
	const path = realpathSync(filename);
	const reader = new Database(path, { readonly: true });
	let applied: Set<string>;
	try {
		applied = new Set(
			(
				reader.query("SELECT id FROM schema_migrations_v2").all() as {
					id: string;
				}[]
			).map((row) => row.id),
		);
	} finally {
		reader.close();
	}
	// openStore takes the normal exclusive owner lock, so a running API refuses the backup.
	const store = openStore(
		path,
		migrations.filter((m) => applied.has(m.id)),
		{ legacyOrder },
	);
	try {
		const backupPath = await store.maintenance!((db) =>
			backupOnRequest(db, path),
		);
		return { backupPath };
	} finally {
		await store.close();
	}
}

if (import.meta.main) {
	try {
		console.log(
			JSON.stringify(await backupDatabaseOnRequest(loadProcessConfig().dbPath)),
		);
	} catch {
		console.error("db_backup_failed (stop the API before backing up)");
		process.exitCode = 1;
	}
}
