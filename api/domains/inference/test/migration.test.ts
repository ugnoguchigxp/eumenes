import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { migration, parentsMigration, diagnosticsMigration } from "..";
test("append-only diagnostics migration preserves previous inference attempts", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-inference-upgrade-"));
	const path = join(dir, "test.db");
	let store = openStore(path, [migration, parentsMigration]);
	try {
		await store.write((db) => {
			db.query(
				"INSERT INTO inference_requests(id,subject,purpose,snapshot,deadline) VALUES('r','subject','llm','{}',123)",
			).run();
			db.query(
				"INSERT INTO inference_attempts(id,request_id,source,status,reason,started) VALUES('a','r','larm','failed','larm_inference_409',123)",
			).run();
		});
		await store.close();
		store = openStore(path, [
			migration,
			parentsMigration,
			diagnosticsMigration,
		]);
		expect(
			store.read((db) =>
				db
					.query("SELECT id,reason,provider_details FROM inference_attempts")
					.get(),
			),
		).toEqual({
			id: "a",
			reason: "larm_inference_409",
			provider_details: "[]",
		});
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
