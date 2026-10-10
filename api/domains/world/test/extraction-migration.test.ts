import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrations } from "../../../application/migrations";
import {
	openStore,
	MigrationUnknownAppliedError,
} from "../../../infrastructure/sqlite";

test("extraction hold migration preserves old received and terminal rows and refuses an old binary", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-world-upgrade-"));
	const path = join(dir, "db.sqlite3");
	const oldMigrations = migrations.filter(
		(m) => m.id !== "world/0008-extraction-hold",
	);
	let store = openStore(path, oldMigrations);
	try {
		await store.write((db) => {
			const insert = db.query(`INSERT INTO world_host_extract_event
        (principal, scope_key, event_id, seq, feed_scope_keys, feed_restore_epoch,
         received_cursor, source_key, source_json, state, received_at_ms, settled_at_ms)
        VALUES ('fixture', 'scope', ?, ?, '[]', 'epoch', ?, 'source', '{}', ?, 1, ?)`);
			insert.run("waiting", 1, "cursor-1", "received", null);
			insert.run("done", 2, "cursor-2", "applied", 2);
		});
		const before = store.read((db) =>
			db
				.query(
					"SELECT event_id, state, settled_at_ms FROM world_host_extract_event ORDER BY seq",
				)
				.all(),
		);
		await store.close();
		store = openStore(path, migrations);
		expect(
			store.read((db) =>
				db
					.query(
						"SELECT event_id, state, settled_at_ms FROM world_host_extract_event ORDER BY seq",
					)
					.all(),
			),
		).toEqual(before);
		expect(
			store.read((db) =>
				db
					.query("SELECT held_context_digest FROM world_host_extract_event")
					.all(),
			),
		).toEqual([{ held_context_digest: null }, { held_context_digest: null }]);
		await expect(
			store.write((db) => {
				db.query(
					"UPDATE world_host_extract_event SET held_context_digest = 'bad'",
				).run();
			}),
		).rejects.toThrow();
		await store.close();
		expect(() => openStore(path, oldMigrations)).toThrow(
			MigrationUnknownAppliedError,
		);
		store = openStore(path, migrations);
		expect(
			store.read((db) =>
				db
					.query(
						"SELECT event_id, state, settled_at_ms FROM world_host_extract_event ORDER BY seq",
					)
					.all(),
			),
		).toEqual(before);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
