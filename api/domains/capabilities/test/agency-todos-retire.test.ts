import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations } from "..";

test("capabilities/0014-retire-agency-todos takes the TODO screen off the launcher and keeps the other pointers", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agency-todos-retire-"));
	const path = join(dir, "db");
	const before = migrations.slice(
		0,
		migrations.findIndex(
			(m) => m.id === "capabilities/0014-retire-agency-todos",
		),
	);
	let store = openStore(path, before);
	try {
		await store.write((db) => {
			for (const [id, revision] of [
				["agency.todos", "artifact:agency.todos@4"],
				["music.generation", "artifact:music.generation@1"],
			] as const)
				db.query(
					"INSERT INTO capability_artifact_pointers(artifact_id,active_revision_id,updated_at_ms) VALUES(?,?,1)",
				).run(id, revision);
		});
		await store.close();
		store = openStore(path, migrations);
		expect(
			store.read((db) =>
				db.query("SELECT artifact_id FROM capability_artifact_pointers").all(),
			),
		).toEqual([{ artifact_id: "music.generation" }]);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
