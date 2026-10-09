import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./index";

const open = () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-snapshot-"));
	const store = openStore(join(dir, "db.sqlite3"), [
		"CREATE TABLE items(value TEXT)",
	]);
	return { dir, store };
};

test("readSnapshot shows one committed snapshot while a writer commits in between", async () => {
	const { dir, store } = open();
	try {
		await store.write((db) => db.query("INSERT INTO items VALUES('a')").run());
		let afterConcurrentWrite: unknown;
		let pendingWrite: Promise<unknown> | undefined;
		const before = store.readSnapshot((db) => {
			const first = db.query("SELECT value FROM items").all();
			// The Writer commits while this read transaction is open.
			pendingWrite = store.write((writer) =>
				writer.query("INSERT INTO items VALUES('b')").run(),
			);
			return first;
		});
		await pendingWrite;
		expect(before).toEqual([{ value: "a" }]);
		// A snapshot taken before the commit never sees it; a new one does.
		afterConcurrentWrite = store.readSnapshot((db) =>
			db.query("SELECT value FROM items ORDER BY rowid").all(),
		);
		expect(afterConcurrentWrite).toEqual([{ value: "a" }, { value: "b" }]);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("A35 readSnapshot is read-only, synchronous and refused while closing", async () => {
	const { dir, store } = open();
	try {
		expect(() =>
			store.readSnapshot((db) =>
				db.query("INSERT INTO items VALUES('x')").run(),
			),
		).toThrow();
		expect(() =>
			// @ts-expect-error async callbacks are rejected by the type
			store.readSnapshot(async (db) => db.query("SELECT 1").all()),
		).toThrow("async_snapshot_callback");
		expect(
			store.read((db) => db.query("SELECT value FROM items").all()),
		).toEqual([]);
		const closing = store.close();
		expect(() =>
			store.readSnapshot((db) => db.query("SELECT 1").all()),
		).toThrow("database_closing");
		await closing;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("A35 the snapshot callback never gets a writer: nested store.write queues after it", async () => {
	const { dir, store } = open();
	try {
		const order: string[] = [];
		let queued: Promise<unknown> | undefined;
		store.readSnapshot((db) => {
			queued = store.write((writer) => {
				order.push("write");
				writer.query("INSERT INTO items VALUES('n')").run();
			});
			order.push("snapshot");
			return db.query("SELECT value FROM items").all();
		});
		await queued;
		expect(order).toEqual(["snapshot", "write"]);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
