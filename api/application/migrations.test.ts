import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertMemorySchema,
	migrations as memoryPackageMigrations,
} from "eumenes-memory/sqlite";
import { openStore } from "../infrastructure/sqlite";
import { createConversationService } from "../domains/conversation";
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

test("an applied migration that is rewritten later stops startup with its id only", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-checksum-"));
	try {
		const path = join(dir, "db.sqlite3");
		const original = [
			"CREATE TABLE a (x INTEGER)",
			"CREATE TABLE b (y INTEGER)",
		];
		const store = openStore(path, original);
		await store.close();
		const rewritten = [original[0]!, "CREATE TABLE b (y INTEGER, z TEXT)"];
		let error: unknown;
		try {
			openStore(path, rewritten);
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("migration_checksum_mismatch");
		expect((error as { migrationId: number }).migrationId).toBe(2);
		expect(JSON.stringify(error)).not.toContain("CREATE TABLE");
		// The unchanged list still opens.
		const again = openStore(path, original);
		await again.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a database from before checksums is backfilled once and then verified", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-checksum-legacy-"));
	try {
		const path = join(dir, "db.sqlite3");
		const list = ["CREATE TABLE a (x INTEGER)", "CREATE TABLE b (y INTEGER)"];
		const legacy = new Database(path, { create: true });
		legacy.exec(
			"CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY); INSERT INTO schema_migrations (id) VALUES (1),(2);" +
				list.join(";"),
		);
		legacy.close();
		const store = openStore(path, list);
		const rows = store.read((db) =>
			db.query("SELECT id, checksum FROM schema_migrations ORDER BY id").all(),
		) as { id: number; checksum: string | null }[];
		expect(rows.map((r) => r.id)).toEqual([1, 2]);
		expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.checksum ?? ""))).toBe(
			true,
		);
		await store.close();
		expect(() =>
			openStore(path, [list[0]!, "CREATE TABLE b (y TEXT)"]),
		).toThrow("migration_checksum_mismatch");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an existing 0.3.3 host database upgrades without rewriting migration checksums or losing data", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-web-upgrade-"));
	try {
		const path = join(dir, "db.sqlite3");
		const previous = [
			...hostMigrations,
			...memoryPackageMigrations.slice(0, 4),
			serviceTestsMigration,
		];
		const before = openStore(path, previous);
		await createConversationService(before).append({
			id: "fixture-message",
			conversationId: "fixture-conversation",
			role: "user",
			text: "preserved across upgrade",
			createdAt: "2026-10-09T00:00:00.000Z",
			runId: null,
		});
		const checksums = before.read((db) =>
			db.query("SELECT id,checksum FROM schema_migrations ORDER BY id").all(),
		);
		await before.close();
		const after = openStore(path, migrations);
		try {
			after.read((db) => assertMemorySchema(db));
			expect(
				createConversationService(after).get("fixture-conversation").messages[0]
					?.text,
			).toBe("preserved across upgrade");
			expect(
				after.read((db) =>
					db
						.query(
							"SELECT id,checksum FROM schema_migrations WHERE id<=? ORDER BY id",
						)
						.all(previous.length),
				),
			).toEqual(checksums);
			expect(
				after.read((db) =>
					db
						.query(
							"SELECT name FROM sqlite_master WHERE name IN ('memory_record_retention','web_research_runs') ORDER BY name",
						)
						.all(),
				),
			).toHaveLength(2);
		} finally {
			await after.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
