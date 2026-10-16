import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { migrations as tasksMigrations } from "../../tasks";
import { migrations } from "..";

let store: SqliteStore | undefined;
let dir = "";
afterEach(() => {
	void store?.close();
	store = undefined;
	if (dir) rmSync(dir, { recursive: true, force: true });
});

function plan(sql: string): string {
	if (!store) {
		dir = mkdtempSync(join(tmpdir(), "supervision-indexes-"));
		store = openStore(join(dir, "test.sqlite"), [
			...tasksMigrations,
			...migrations,
		]);
	}
	return store.read((db) =>
		(db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
			.map((r) => r.detail)
			.join("\n"),
	);
}

test("supervision trim and purge use their task indexes", () => {
	expect(
		plan(
			"DELETE FROM coding_observations WHERE task_id='t' AND id NOT IN (SELECT id FROM coding_observations WHERE task_id='t' ORDER BY created_ms DESC,rowid DESC LIMIT 128)",
		),
	).toContain("coding_observations_task_created");
	expect(plan("DELETE FROM coding_decisions WHERE task_id='t'")).toContain(
		"coding_decisions_task",
	);
	expect(plan("DELETE FROM coding_steps WHERE task_id='t'")).toContain(
		"coding_steps_task",
	);
});
