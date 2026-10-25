import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyEventsSchema } from "../domains/continuity/test/legacy-events.fixture";
import { openStore, WriterOwnedError } from "../infrastructure/sqlite";
import { migrations } from "./migrations";
import { repairLegacyContinuity } from "./repair-legacy-continuity";

test("offline repair backs up the old ledger and allows the full startup migrations without changing applied checksums", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-legacy-repair-"));
	const path = join(dir, "db.sqlite3");
	// The other migrations have already committed when the collision is reached.
	const before = migrations.filter((m) => m.id !== "continuity/0004-events");
	let store = openStore(path, before);
	try {
		await store.write((db) => db.exec(legacyEventsSchema));
		const checksums = store.read((db) =>
			db
				.query("SELECT id, checksum FROM schema_migrations_v2 ORDER BY id")
				.all(),
		);
		await expect(repairLegacyContinuity(path)).rejects.toBeInstanceOf(
			WriterOwnedError,
		);
		await store.close();
		expect(() => openStore(path, migrations)).toThrow("already exists");
		const result = await repairLegacyContinuity(path);
		expect(result.repaired).toBe(true);
		const backup = new Database(result.backupPath!, { readonly: true });
		try {
			expect(
				backup
					.query(
						"SELECT name FROM pragma_table_info('continuity_events') WHERE name='bookmark_id'",
					)
					.get(),
			).toEqual({ name: "bookmark_id" });
		} finally {
			backup.close();
		}
		store = openStore(path, before);
		expect(
			store.read((db) =>
				db
					.query("SELECT id, checksum FROM schema_migrations_v2 ORDER BY id")
					.all(),
			),
		).toEqual(checksums);
		await store.close();
		store = openStore(path, migrations);
		expect(
			store.read((db) => db.query("PRAGMA integrity_check").get()),
		).toEqual({ integrity_check: "ok" });
		expect(
			store.read((db) => db.query("PRAGMA foreign_key_check").all()),
		).toEqual([]);
		expect(
			store.read((db) =>
				db.query("SELECT COUNT(*) AS n FROM continuity_events").get(),
			),
		).toEqual({ n: 0 });
		await store.close();
		expect(await repairLegacyContinuity(path)).toEqual({ repaired: false });
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
