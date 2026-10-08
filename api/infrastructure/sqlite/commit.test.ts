import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./index";

test("commit notifications see persisted state, exclude idle scans/rollback, and cannot fail writes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-commit-"));
	const store = openStore(join(dir, "db.sqlite3"), [
		"CREATE TABLE items(value TEXT)",
	]);
	const observed: unknown[] = [];
	const stop = store.onCommit(() =>
		observed.push(
			store.read((db) => db.query("SELECT value FROM items").all()),
		),
	);
	store.onCommit(() => {
		throw new Error("listener_failed");
	});
	try {
		await store.write((db) => db.query("SELECT value FROM items").all());
		await expect(
			store.write((db) => {
				db.query("INSERT INTO items VALUES('rolled back')").run();
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		await store.write((db) =>
			db.query("UPDATE items SET value='none' WHERE value='missing'").run(),
		);
		expect(observed).toHaveLength(0);
		await store.write((db) =>
			db.query("INSERT INTO items VALUES('saved')").run(),
		);
		expect(observed).toEqual([[{ value: "saved" }]]);
		stop();
		await store.write((db) =>
			db.query("INSERT INTO items VALUES('later')").run(),
		);
		expect(observed).toHaveLength(1);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
