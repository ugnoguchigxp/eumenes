import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations } from "../repository";

test("continuity/0006 retracts the open activity notes and leaves the other notes as they were", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-continuity-0006-"));
	const path = join(dir, "db.sqlite3");
	try {
		const before = migrations.filter(
			(m) => m.id !== "continuity/0006-retract-activity",
		);
		const old = openStore(path, before);
		await old.write((db) => {
			const insert = db.query(
				"INSERT INTO continuity_items (id, conversation_id, kind, text, status, revision, created_at, updated_at, origin) VALUES (?, 'c1', ?, 'x', ?, 1, 't', 't', 'agent')",
			);
			insert.run("a1", "activity", "active");
			insert.run("a2", "activity", "resolved");
			insert.run("d1", "decision", "active");
		});
		await old.close();
		const store = openStore(path, migrations);
		try {
			expect(
				store.read((db) =>
					db
						.query(
							"SELECT id, status, revision FROM continuity_items ORDER BY id",
						)
						.all(),
				),
			).toEqual([
				{ id: "a1", status: "retracted", revision: 2 },
				{ id: "a2", status: "resolved", revision: 1 },
				{ id: "d1", status: "active", revision: 1 },
			]);
		} finally {
			await store.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
