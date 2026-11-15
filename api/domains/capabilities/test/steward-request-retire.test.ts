import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations } from "..";

for (const [migration, retired] of [
	[
		"capabilities/0007-retire-steward-request",
		["toolchain:steward.request", "tool:steward.request"],
	],
	[
		"capabilities/0011-retire-legacy-research",
		["toolchain:web.search", "toolchain:web.research"],
	],
	[
		"capabilities/0012-retire-older-web-packages",
		[
			"package:web.research",
			"package:web.lookup",
			"package:web.read",
			"profile:web.quick",
			"profile:web.recipe",
			"profile:web.research",
			"skill:web.recipe",
			"skill:web.research",
			"skill:web.search",
			"tool:web.forecast",
			"tool:web.quote",
		],
	],
] as const)
	test(`${migration} removes active entries, search and embeddings, preserving revisions`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "steward-request-retire-"));
		const path = join(dir, "db");
		const before = migrations.slice(
			0,
			migrations.findIndex((m) => m.id === migration),
		);
		let store = openStore(path, before);
		try {
			await store.write((db) => {
				for (const key of [...retired, "toolchain:history.research"]) {
					const [kind, id] = key.split(":") as [string, string];
					db.query(
						"INSERT INTO capability_items(key,id,kind,active_revision_id,origin) VALUES(?,?,?,?,'builtin')",
					).run(key, id, kind, `${key}@1`);
					db.query("INSERT INTO capability_revisions VALUES(?,?,?,?,?,?)").run(
						`${key}@1`,
						key,
						1,
						"{}",
						"hash",
						1,
					);
					db.query(
						"INSERT INTO capability_search(key,content) VALUES(?,?)",
					).run(key, id);
					if (kind === "toolchain" || id === "steward.request")
						db.query(
							"INSERT INTO capability_toolchain_vectors VALUES(?,?,?,?,?)",
						).run(`${key}@1`, 0, "space", "digest", new Uint8Array([1]));
				}
			});
			await store.close();
			store = openStore(path, migrations);
			const rows = (sql: string) => store.read((db) => db.query(sql).all());
			expect(rows("SELECT key FROM capability_items")).toEqual([
				{ key: "toolchain:history.research" },
			]);
			expect(rows("SELECT key FROM capability_search")).toEqual([
				{ key: "toolchain:history.research" },
			]);
			expect(
				rows("SELECT revision_id FROM capability_toolchain_vectors"),
			).toEqual([{ revision_id: "toolchain:history.research@1" }]);
			expect(
				rows("SELECT id FROM capability_revisions ORDER BY id"),
			).toHaveLength(retired.length + 1);
		} finally {
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
