import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertMemorySchema,
	migrations as memoryPackageMigrations,
} from "eumenes-memory/sqlite";
import { openStore } from "../infrastructure/sqlite";
import { hostMigrations, migrations } from "./migrations";
import { migration as serviceTestsMigration } from "../domains/service-tests";

test("the memory package's migrations keep their order and every one is applied; the first four stay contiguous", () => {
	expect(memoryPackageMigrations.length).toBeGreaterThan(0);
	// In order as a subsequence (a host migration may sit between package migrations only
	// where it already did when those package migrations were first deployed).
	let cursor = 0;
	for (const migration of memoryPackageMigrations) {
		const at = migrations.indexOf(migration, cursor);
		expect(at).toBeGreaterThanOrEqual(cursor);
		cursor = at + 1;
	}
	// The original block: the first four package migrations follow the host block directly.
	expect(
		migrations.slice(hostMigrations.length, hostMigrations.length + 4),
	).toEqual(memoryPackageMigrations.slice(0, 4));
	expect(migrations[hostMigrations.length + 4]).toBe(serviceTestsMigration);
	expect(migrations.slice(0, hostMigrations.length)).toEqual([
		...hostMigrations,
	]);
});

test("host migrations are append-only: the count and the retired slot never move", () => {
	// Raise this number only when appending a new host migration (and re-check the package block).
	expect(hostMigrations).toHaveLength(18);
	expect(hostMigrations[7]).toBe("SELECT 1");
});

test("a fresh database gets every migration and passes the memory schema check", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-migrations-"));
	try {
		const store = openStore(join(dir, "db.sqlite3"), migrations);
		store.read((db) => assertMemorySchema(db));
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
