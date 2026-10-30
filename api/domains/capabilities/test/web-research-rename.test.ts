import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createCapabilities, migrations, type BundleHost } from "..";

const host = (): BundleHost => ({
	adapters: new Map(),
	availability: new Set(),
	inputAdapters: new Set(),
	projections: new Set(),
	domainSchemas: new Set(),
});

test("the model-named Web research toolchain is retired and the Web research toolchain is not registered again", async () => {
	const dir = mkdtempSync(join(tmpdir(), "web-research-rename-"));
	const path = join(dir, "db");
	const retired = "toolchain:web.research.luna";
	const before = migrations.slice(
		0,
		migrations.findIndex(
			(m) => m.id === "capabilities/0006-retire-model-named-web-research",
		),
	);
	let store = openStore(path, before);
	try {
		await store.write((db) => {
			db.query(
				"INSERT INTO capability_items(key,id,kind,active_revision_id) VALUES(?,?,?,?)",
			).run(retired, "web.research.luna", "toolchain", `${retired}@3`);
			db.query("INSERT INTO capability_revisions VALUES(?,?,?,?,?,?)").run(
				`${retired}@3`,
				retired,
				3,
				JSON.stringify({ functionName: "web_research" }),
				"hash",
				1,
			);
			db.query("INSERT INTO capability_search(key,content) VALUES(?,?)").run(
				retired,
				"web.research.luna",
			);
		});
		await store.close();
		store = openStore(path, migrations);
		const rows = (sql: string) => store.read((db) => db.query(sql).all());
		expect(rows("SELECT key FROM capability_items")).toEqual([]);
		expect(rows("SELECT key FROM capability_search")).toEqual([]);
		// The retired revisions stay as history.
		expect(rows("SELECT id FROM capability_revisions")).toEqual([
			{ id: `${retired}@3` },
		]);
		await createCapabilities(store, new Set(["web"]), {
			bundleHost: host,
		}).seed();
		expect(
			rows(
				"SELECT key,active_revision_id FROM capability_items WHERE key LIKE 'toolchain:web.%' ORDER BY key",
			),
		).toEqual([
			{
				key: "toolchain:web.search",
				active_revision_id: "toolchain:web.search@8",
			},
		]);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
