import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations as conversationMigrations } from "../../conversation";
import { migrations as stewardMigrations } from "../repository";

test("steward/0003 carries the units, requests and decisions over to the event flow", async () => {
	const dir = mkdtempSync(join(tmpdir(), "steward-0003-"));
	const path = join(dir, "db.sqlite3");
	try {
		const before = [
			...conversationMigrations,
			...stewardMigrations.slice(0, 2),
		];
		const old = openStore(path, before);
		await old.write((db) => {
			const unit = db.query(
				`INSERT INTO steward_unit (id, conversation_id, kind, step, slot, targets, state, created_at, closed_at)
				 VALUES (?,?,?,?,?,?,?,?,?)`,
			);
			unit.run(
				"u-open",
				"c1",
				"exchange_step",
				"curate-memory",
				"reflect",
				"{}",
				"open",
				"t1",
				null,
			);
			unit.run(
				"u-done",
				"c1",
				"exchange_step",
				"summarize",
				"reflect",
				"{}",
				"applied",
				"t2",
				"t3",
			);
			unit.run(
				"u-dispose",
				"c1",
				"exchange_step",
				"dispose-exchanges",
				"reflect",
				"{}",
				"applied",
				"t4",
				"t5",
			);
			const inbox = db.query(
				`INSERT INTO steward_inbox (id, conversation_id, run_id, message_id, kind, what, state, created_at)
				 VALUES (?,?,?,?,?,?,?,?)`,
			);
			inbox.run(
				"r-staged",
				"c1",
				"run-1",
				"m1",
				"forget",
				"住所",
				"staged",
				"t1",
			);
			inbox.run(
				"r-discarded",
				"c1",
				"run-2",
				"m2",
				"forget",
				"",
				"discarded",
				"t2",
			);
			inbox.run("r-done", "c1", "run-3", "m3", "remember", "", "done", "t3");
			db.query(
				"INSERT INTO steward_decision (conversation_id, job_id, step, created_at) VALUES ('c1','j1','dispose-exchanges','t'), ('c1','j2','curate-memory','t')",
			).run();
			db.query(
				"INSERT INTO steward_goal_todo (input_message_id, conversation_id) VALUES ('m1','c1')",
			).run();
			db.query(
				"INSERT INTO steward_state (conversation_id, recall_pending) VALUES ('c1','m9')",
			).run();
		});
		await old.close();
		const upgraded = openStore(path, [
			...conversationMigrations,
			...stewardMigrations,
		]);
		try {
			const rows = <T>(sql: string) =>
				upgraded.read((db) => db.query(sql).all() as T[]);
			expect(
				rows("SELECT id, kind, step, state FROM steward_unit ORDER BY id"),
			).toEqual([
				{ id: "u-done", kind: "events", step: "summarize", state: "applied" },
				{ id: "u-open", kind: "events", step: "curate-memory", state: "stale" },
			]);
			expect(
				rows(
					"SELECT id, source_ref, state, what FROM steward_inbox ORDER BY id",
				),
			).toEqual([
				{ id: "r-discarded", source_ref: "m2", state: "none", what: "" },
				{ id: "r-done", source_ref: "m3", state: "done", what: "" },
				{ id: "r-staged", source_ref: "m1", state: "pending", what: "住所" },
			]);
			expect(rows("SELECT step FROM steward_decision")).toEqual([
				{ step: "curate-memory" },
			]);
			expect(rows("SELECT * FROM steward_goal_todo")).toEqual([]);
			expect(rows("SELECT recall_pending AS p FROM steward_state")).toEqual([
				{ p: null },
			]);
			// The new shapes accept what the steward writes now.
			await upgraded.write((db) => {
				db.query(
					"INSERT INTO steward_unit (id, conversation_id, kind, step, slot, targets, state, created_at) VALUES ('u-new','c1','maintenance','summarize','episode','{}','open','t')",
				).run();
				db.query(
					"INSERT INTO steward_inbox (id, conversation_id, source_ref, kind, what, state, created_at) VALUES ('r-new','c1','m4','withdraw','x','pending','t')",
				).run();
			});
		} finally {
			await upgraded.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
