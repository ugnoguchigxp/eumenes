import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrations } from "../../../application/migrations";
import {
	openStore,
	MigrationUnknownAppliedError,
} from "../../../infrastructure/sqlite";

const STEWARD = ["world/0009-extraction-steward", "world/0010-forget-origin"];

test("the steward migrations keep old events and forgets, add speaker and conversation, drop the job columns, and an old binary refuses the database", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-world-upgrade-"));
	const path = join(dir, "db.sqlite3");
	const oldMigrations = migrations.filter((m) => !STEWARD.includes(m.id));
	let store = openStore(path, oldMigrations);
	try {
		await store.write((db) => {
			const insert = db.query(`INSERT INTO world_host_extract_event
        (principal, scope_key, event_id, seq, feed_scope_keys, feed_restore_epoch,
         received_cursor, source_key, source_json, state, received_at_ms, settled_at_ms)
        VALUES ('fixture', 'scope', ?, ?, '[]', 'epoch', ?, 'source', '{}', ?, 1, ?)`);
			insert.run("waiting", 1, "cursor-1", "received", null);
			insert.run("done", 2, "cursor-2", "applied", 2);
			db.query(
				`INSERT INTO world_host_forget_intake
				(forget_id, principal, scope_key, reason_code, origin, roots_json, roots_digest, state, created_at, updated_at)
				VALUES ('f-1', 'fixture', 'scope', 'FORGET_REQUESTED', 'request', '[]', ?, 'pending', 1, 1)`,
			).run("a".repeat(64));
		});
		await store.close();
		store = openStore(path, migrations);
		expect(
			store.read((db) =>
				db
					.query(
						"SELECT event_id, state, settled_at_ms, speaker, conversation_id FROM world_host_extract_event ORDER BY seq",
					)
					.all(),
			),
		).toEqual([
			{
				event_id: "waiting",
				state: "received",
				settled_at_ms: null,
				speaker: "user",
				conversation_id: null,
			},
			{
				event_id: "done",
				state: "applied",
				settled_at_ms: 2,
				speaker: "user",
				conversation_id: null,
			},
		]);
		const columns = store
			.read((db) =>
				db
					.query(
						"SELECT name FROM pragma_table_info('world_host_extract_event')",
					)
					.all(),
			)
			.map((c) => (c as { name: string }).name);
		for (const gone of ["job_id", "request_id", "failures", "retry_at_ms"])
			expect(columns).not.toContain(gone);
		// The forget intake survived the rebuild and now takes the steward as an origin.
		expect(
			store.read((db) =>
				db
					.query(
						"SELECT forget_id, origin, state FROM world_host_forget_intake",
					)
					.all(),
			),
		).toEqual([{ forget_id: "f-1", origin: "request", state: "pending" }]);
		await store.write((db) => {
			db.query(
				`INSERT INTO world_host_forget_intake
				(forget_id, principal, scope_key, reason_code, origin, roots_json, roots_digest, state, created_at, updated_at)
				VALUES ('f-2', 'fixture', 'scope', 'SOURCE_FORGOTTEN', 'steward', '[]', ?, 'pending', 1, 1)`,
			).run("b".repeat(64));
		});
		await expect(
			store.write((db) => {
				db.query(
					"UPDATE world_host_extract_event SET speaker = 'system' WHERE event_id = 'done'",
				).run();
			}),
		).rejects.toThrow();
		await store.close();
		expect(() => openStore(path, oldMigrations)).toThrow(
			MigrationUnknownAppliedError,
		);
	} finally {
		await store.close().catch(() => {});
		rmSync(dir, { recursive: true, force: true });
	}
});
