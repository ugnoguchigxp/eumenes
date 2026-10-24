import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations } from "..";

test("dropping the held-report table sends a held notice as an ordinary one", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-reports-drop-"));
	const path = join(dir, "test.db");
	const dropId = "agent-runtime/0011-drop-execution-reports";
	let store = openStore(
		path,
		migrations.slice(
			0,
			migrations.findIndex((m) => m.id === dropId),
		),
	);
	try {
		await store.write((db) => {
			for (const [id, state] of [
				["held", "accepted"],
				["sent", "accepted"],
				["fresh", "pending"],
			] as const)
				db.query(
					"INSERT INTO agent_execution_events(id,execution_id,kind,state) VALUES(?,?,?,?)",
				).run(id, `e-${id}`, "result", state);
			db.query(
				"INSERT INTO agent_execution_reports(event_id,execution_id,conversation_id,state,held_at) VALUES('held','e-held','c1','held',1)",
			).run();
			db.query(
				"INSERT INTO agent_execution_reports(event_id,execution_id,conversation_id,state,held_at,released_at) VALUES('sent','e-sent','c1','released',1,2)",
			).run();
		});
		await store.close();
		store = openStore(path, migrations);
		expect(
			store.read((db) =>
				db
					.query("SELECT id,state FROM agent_execution_events ORDER BY id")
					.all(),
			),
		).toEqual([
			{ id: "fresh", state: "pending" },
			{ id: "held", state: "pending" },
			{ id: "sent", state: "accepted" },
		]);
		expect(
			store.read((db) =>
				db
					.query(
						"SELECT name FROM sqlite_master WHERE name LIKE 'agent_execution_reports%'",
					)
					.all(),
			),
		).toEqual([]);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
