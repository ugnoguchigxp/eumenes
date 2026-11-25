import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { migrations as memoryPackageMigrations } from "eumenes-memory/sqlite";
import {
	openStore,
	orderMigrations,
	type SqliteStore,
} from "../../../infrastructure/sqlite";
import { migrations as agentRuntimeMigrations } from "../../agent-runtime";
import { migrations as capabilitiesMigrations } from "../../capabilities";
import { migrations as continuityMigrations } from "../../continuity";
import { migrations as conversationMigrations } from "../../conversation";
import { migrations as goalsMigrations } from "../../goals";
import { migrations as inferenceMigrations } from "../../inference";
import { migrations as memoryMigrations } from "../../memory";
import { migrations as queueMigrations } from "../../queue";
import { migrations as schedulerMigrations } from "../../scheduler";
import { migrations as settingsMigrations } from "../../settings";
import { migrations as dialogueMigrations } from "..";

/**
 * The migrations a dialogue test database needs: every domain's own list, ordered by its dependencies. No
 * migration is picked by hand, so a new domain migration reaches every test without an edit here.
 */
export function dialogueMigrationList() {
	return orderMigrations([
		...conversationMigrations,
		...queueMigrations,
		...schedulerMigrations,
		...settingsMigrations,
		...inferenceMigrations,
		...capabilitiesMigrations,
		...agentRuntimeMigrations,
		...continuityMigrations,
		...memoryMigrations,
		...memoryPackageMigrations,
		...goalsMigrations,
		...dialogueMigrations,
	]);
}

/** A fresh SQLite file in its own directory, with dialogue's full schema. */
export function openDialogueStore(
	prefix: string,
	extra: import("../../../infrastructure/sqlite").Migration[] = [],
): {
	dir: string;
	store: SqliteStore;
} {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	const store = openStore(
		join(dir, "db.sqlite3"),
		orderMigrations([...dialogueMigrationList(), ...extra]),
	);
	return { dir, store };
}

export function removeDialogueStore(dir: string) {
	rmSync(dir, { recursive: true, force: true });
}
