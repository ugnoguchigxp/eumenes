import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./index";
import {
	DatabaseIntegrityError,
	PRE_MIGRATION_BACKUPS_KEPT,
} from "./pre-migration-backup";

const first = "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)";
const second = "ALTER TABLE t ADD COLUMN extra TEXT";
const temp = () => mkdtempSync(join(tmpdir(), "eumenes-backup-"));
const backups = (dir: string) =>
	readdirSync(dir).filter((name) => name.includes(".pre-migration-"));

test("a fresh database is migrated without a snapshot", async () => {
	const dir = temp();
	try {
		const store = openStore(join(dir, "db.sqlite3"), [first, second]);
		await store.close();
		expect(backups(dir)).toEqual([]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pending migrations on an existing database take a private consistent snapshot first", async () => {
	const dir = temp();
	const file = join(dir, "db.sqlite3");
	try {
		const old = openStore(file, [first]);
		await old.write((db) => db.exec("INSERT INTO t (v) VALUES ('kept')"));
		await old.close();
		// Reopening with the same migrations has nothing pending: no snapshot.
		await openStore(file, [first]).close();
		expect(backups(dir)).toEqual([]);

		const store = openStore(file, [first, second]);
		await store.close();
		const [name, ...others] = backups(dir);
		expect(others).toEqual([]);
		const snapshot = join(dir, name!);
		expect(statSync(snapshot).mode & 0o777).toBe(0o600);
		const copy = new Database(snapshot, { readonly: true });
		try {
			// The snapshot predates the pending migration.
			expect(copy.query("SELECT v FROM t").all()).toEqual([{ v: "kept" }]);
			expect(
				(copy.query("PRAGMA table_info(t)").all() as { name: string }[]).map(
					(c) => c.name,
				),
			).toEqual(["id", "v"]);
		} finally {
			copy.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("only a bounded number of snapshots is kept", async () => {
	const dir = temp();
	const file = join(dir, "db.sqlite3");
	try {
		const list = [first];
		await openStore(file, list).close();
		for (let n = 0; n < PRE_MIGRATION_BACKUPS_KEPT + 2; n++) {
			list.push(`CREATE TABLE extra_${n} (id INTEGER PRIMARY KEY)`);
			await Bun.sleep(2);
			await openStore(file, list).close();
		}
		expect(backups(dir)).toHaveLength(PRE_MIGRATION_BACKUPS_KEPT);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a database that fails the integrity check is not migrated", async () => {
	const dir = temp();
	const file = join(dir, "db.sqlite3");
	try {
		const old = openStore(file, [first]);
		await old.write((db) => {
			db.exec("CREATE INDEX t_v ON t (v)");
			for (let n = 0; n < 300; n++)
				db.query("INSERT INTO t (v) VALUES (?)").run(`value-${n}`);
		});
		await old.close();
		// Damage an index page in the main file (WAL is checkpointed on close).
		const bytes = readFileSync(file);
		const pageSize = 4096;
		for (let page = 2; page * pageSize < bytes.length; page++)
			bytes.fill(0xff, page * pageSize + 100, page * pageSize + 200);
		writeFileSync(file, bytes);
		expect(() => openStore(file, [first, second])).toThrow(
			DatabaseIntegrityError,
		);
		expect(backups(dir)).toEqual([]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
