import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations } from "..";

test("the steward.request items lose their active entry, search and embedding; their revisions stay as history", async () => {
	const dir = mkdtempSync(join(tmpdir(), "steward-request-retire-"));
	const path = join(dir, "db");
	const before = migrations.slice(
		0,
		migrations.findIndex(
			(m) => m.id === "capabilities/0007-retire-steward-request",
		),
	);
	let store = openStore(path, before);
	try {
		await store.write((db) => {
			for (const key of [
				"toolchain:steward.request",
				"tool:steward.request",
				"toolchain:web.search",
			]) {
				const [kind, id] = key.split(":") as [string, string];
				db.query(
					"INSERT INTO capability_items(key,id,kind,active_revision_id) VALUES(?,?,?,?)",
				).run(key, id, kind, `${key}@1`);
				db.query("INSERT INTO capability_revisions VALUES(?,?,?,?,?,?)").run(
					`${key}@1`,
					key,
					1,
					"{}",
					"hash",
					1,
				);
				db.query("INSERT INTO capability_search(key,content) VALUES(?,?)").run(
					key,
					id,
				);
				db.query(
					"INSERT INTO capability_toolchain_vectors VALUES(?,?,?,?,?)",
				).run(`${key}@1`, 0, "space", "digest", new Uint8Array([1]));
			}
		});
		await store.close();
		store = openStore(path, migrations);
		const rows = (sql: string) => store.read((db) => db.query(sql).all());
		expect(rows("SELECT key FROM capability_items")).toEqual([
			{ key: "toolchain:web.search" },
		]);
		expect(rows("SELECT key FROM capability_search")).toEqual([
			{ key: "toolchain:web.search" },
		]);
		expect(
			rows("SELECT revision_id FROM capability_toolchain_vectors"),
		).toEqual([{ revision_id: "toolchain:web.search@1" }]);
		expect(
			rows("SELECT id FROM capability_revisions ORDER BY id"),
		).toHaveLength(3);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
