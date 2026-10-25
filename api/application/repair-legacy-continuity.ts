import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import {
	archiveLegacyContinuityEventsInTransaction,
	hasLegacyContinuityEvents,
} from "../domains/continuity";
import { loadProcessConfig } from "../infrastructure/config";
import { openStore } from "../infrastructure/sqlite";
import { backupBeforeMigration } from "../infrastructure/sqlite/pre-migration-backup";
import { legacyOrder, migrations } from "./migrations";

/** Explicit offline repair; does not start services or apply pending migrations. */
export async function repairLegacyContinuity(filename: string) {
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
	// openStore takes the normal exclusive owner lock and verifies every applied
	// id/checksum. A concurrent upgrade is refused, never silently ignored.
	const store = openStore(
		path,
		migrations.filter((m) => applied.has(m.id)),
		{ legacyOrder },
	);
	try {
		if (!store.read(hasLegacyContinuityEvents)) return { repaired: false };
		const backupPath = await store.maintenance!((db) =>
			backupBeforeMigration(db, path),
		);
		await store.write(archiveLegacyContinuityEventsInTransaction);
		return { repaired: true, backupPath };
	} finally {
		await store.close();
	}
}

if (import.meta.main) {
	try {
		console.log(
			JSON.stringify(await repairLegacyContinuity(loadProcessConfig().dbPath)),
		);
	} catch {
		console.error("legacy_continuity_repair_failed");
		process.exitCode = 1;
	}
}
