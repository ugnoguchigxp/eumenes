import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations as capabilityMigrations } from "../../capabilities";
import { createToolchainHistory, migrations } from "..";

test("selections saved with an analysis and a repair flag keep everything else when the two columns are dropped", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-history-drop-analysis-"));
	const path = join(dir, "db");
	const before = migrations.filter(
		(migration) => migration.id !== "toolchain-history/0004-drop-analysis",
	);
	let store = openStore(path, [...capabilityMigrations, ...before]);
	try {
		await store.write((db) => {
			db.query(
				"INSERT INTO toolchain_selections(id,run_id,conversation_id,retrieval,candidates_json,history_refs_json,decision,toolchain_id,request_text,repaired,analysis_json,created_at,expires_at) VALUES('a','run-a','main','none','[]','[]','toolchain','web.search','鎌倉の天気',1,'{\"kind\":\"live_info\"}',1,2)",
			).run();
		});
		await store.close();
		store = openStore(path, [...capabilityMigrations, ...migrations]);
		const columns = store
			.read((db) => db.query("PRAGMA table_info(toolchain_selections)").all())
			.map((column) => (column as { name: string }).name);
		expect(columns).not.toContain("analysis_json");
		expect(columns).not.toContain("repaired");
		const history = createToolchainHistory(store, () => 1);
		expect(history.getSelection("run-a")).toMatchObject({
			runId: "run-a",
			toolchainId: "web.search",
			request: "鎌倉の天気",
		});
		expect(history.getSelection("run-a")).not.toHaveProperty("analysis");
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
