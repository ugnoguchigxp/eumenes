import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations as capabilityMigrations } from "../../capabilities";
import { migrations } from "..";

test("selections and recipes saved under the model-named Web research id follow the renamed toolchain", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-history-rename-"));
	const path = join(dir, "db");
	const before = migrations.slice(0, 1);
	let store = openStore(path, [...capabilityMigrations, ...before]);
	try {
		await store.write((db) => {
			for (const [id, toolchain] of [
				["a", "web.research.luna"],
				["b", "web.search"],
			] as const) {
				db.query(
					"INSERT INTO toolchain_selections(id,run_id,conversation_id,retrieval,candidates_json,history_refs_json,decision,toolchain_id,created_at,expires_at) VALUES(?,?,'main','none','[]','[]','toolchain',?,1,2)",
				).run(id, `run-${id}`, toolchain);
				db.query(
					"INSERT INTO toolchain_recipes(id,toolchain_id,signature,url,read_hint,state,created_at,updated_at) VALUES(?,?,'sig','https://example.org','hint','active',1,1)",
				).run(id, toolchain);
			}
		});
		await store.close();
		store = openStore(path, [...capabilityMigrations, ...migrations]);
		for (const table of ["toolchain_selections", "toolchain_recipes"])
			expect(
				store.read((db) =>
					db.query(`SELECT id,toolchain_id FROM ${table} ORDER BY id`).all(),
				),
			).toEqual([
				{ id: "a", toolchain_id: "web.research.codex" },
				{ id: "b", toolchain_id: "web.search" },
			]);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
