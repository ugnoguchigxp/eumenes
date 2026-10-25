import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrations } from "../repository";
import { connect, makeCommand } from "./support";
import { createCommands } from "../service/commands";
import { fakeStore } from "./support";
test("migration preserves commands, leases, delivery FKs, budget, and deleted sequence high-water marks", () => {
	const db = new Database(":memory:");
	db.exec("PRAGMA foreign_keys=ON");
	try {
		for (const m of migrations.slice(0, -1)) db.exec(m.sql);
		connect(db);
		const c = makeCommand({ state: "claimed", leaseId: crypto.randomUUID() });
		db.query(
			"INSERT INTO dots_commands(seq,id,task_id,connection_ref,state,data_json) VALUES(40,?,?,?,?,?)",
		).run(c.commandId, c.taskId, c.connectionRef, c.state, JSON.stringify(c));
		db.query("INSERT INTO dots_deliveries VALUES('delivery',?,'{}')").run(
			c.commandId,
		);
		db.query(
			"INSERT INTO dots_commands(seq,id,task_id,connection_ref,state,data_json) VALUES(1000,'deleted','other','conn','pending','{}')",
		).run();
		db.query("DELETE FROM dots_commands WHERE id='deleted'").run();
		const bytes = db.query("SELECT bytes FROM dots_storage").get();
		db.transaction(() => db.exec(migrations.at(-1)!.sql))();
		expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
		expect(db.query("SELECT bytes FROM dots_storage").get()).toEqual(bytes);
		const row = db
			.query("SELECT seq,data_json FROM dots_commands WHERE id=?")
			.get(c.commandId) as { seq: number; data_json: string };
		expect(row.seq).toBe(40);
		expect(JSON.parse(row.data_json)).toEqual(c);
		createCommands(fakeStore(db), () => 1000000).prepareInTransaction(
			db,
			makeCommand({ commandId: "next" }),
		);
		expect(
			(
				db.query("SELECT seq FROM dots_commands WHERE id='next'").get() as {
					seq: number;
				}
			).seq,
		).toBe(1001);
		expect(db.query("SELECT command_id FROM dots_deliveries").get()).toEqual({
			command_id: c.commandId,
		});
	} finally {
		db.close();
	}
});
