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
				"u-recall",
				"c1",
				"exchange_step",
				"prepare-recall",
				"recall",
				"{}",
				"applied",
				"t4",
				"t5",
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
			...stewardMigrations.slice(0, 5),
		]);
		try {
			const rows = <T>(sql: string) =>
				upgraded.read((db) => db.query(sql).all() as T[]);
			expect(
				rows("SELECT id, kind, step, state FROM steward_unit ORDER BY id"),
			).toEqual([
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
			// The automatic recall is gone with its units and its state (steward/0004).
			expect(
				rows(
					"SELECT name FROM pragma_table_info('steward_state') WHERE name = 'recall_pending'",
				),
			).toEqual([]);
			// The new shapes accept what the steward writes now.
			await upgraded.write((db) => {
				db.query(
					"INSERT INTO steward_unit (id, conversation_id, kind, step, slot, targets, state, created_at) VALUES ('u-new','c1','maintenance','consolidate-memory','maintenance','{}','open','t')",
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

test("steward/0005 drops the episode units, decisions and quiet ranges and the window version of the units", async () => {
	const dir = mkdtempSync(join(tmpdir(), "steward-0005-"));
	const path = join(dir, "db.sqlite3");
	try {
		const old = openStore(path, [
			...conversationMigrations,
			...stewardMigrations.slice(0, 4),
		]);
		await old.write((db) => {
			const unit = db.query(
				`INSERT INTO steward_unit (id, conversation_id, kind, step, slot, targets, window_version, state, created_at)
				 VALUES (?,?,?,?,?,?,?,?,?)`,
			);
			unit.run(
				"u-memory",
				"c1",
				"events",
				"curate-memory",
				"reflect",
				"{}",
				3,
				"applied",
				"t1",
			);
			unit.run(
				"u-summary",
				"c1",
				"maintenance",
				"summarize",
				"episode",
				"{}",
				3,
				"open",
				"t2",
			);
			unit.run(
				"u-merge",
				"c1",
				"maintenance",
				"refine-summary",
				"episode",
				"{}",
				3,
				"failed",
				"t3",
			);
			db.query(
				"INSERT INTO steward_decision (id, conversation_id, job_id, step, created_at) VALUES (1,'c1','j1','summarize','t'), (2,'c1','j2','curate-memory','t'), (3,'c1','j3','refine-summary','t')",
			).run();
			db.query(
				"INSERT INTO steward_decision_ref (decision_id, ref_type, ref_id) VALUES (1,'message','m1'), (2,'message','m2')",
			).run();
			db.query(
				'INSERT INTO steward_state (conversation_id, quiet_steps) VALUES (\'c1\', \'{"quiet":{"consolidate-memory":2},"episode":["summarize:1-4"]}\')',
			).run();
		});
		await old.close();
		const upgraded = openStore(path, [
			...conversationMigrations,
			...stewardMigrations.slice(0, 5),
		]);
		try {
			const rows = <T>(sql: string) =>
				upgraded.read((db) => db.query(sql).all() as T[]);
			expect(rows("SELECT id, slot FROM steward_unit")).toEqual([
				{ id: "u-memory", slot: "reflect" },
			]);
			expect(rows("SELECT id FROM steward_decision")).toEqual([{ id: 2 }]);
			expect(rows("SELECT ref_id FROM steward_decision_ref")).toEqual([
				{ ref_id: "m2" },
			]);
			expect(
				rows(
					"SELECT name FROM pragma_table_info('steward_unit') WHERE name = 'window_version'",
				),
			).toEqual([]);
			expect(
				JSON.parse(
					rows<{ quiet_steps: string }>(
						"SELECT quiet_steps FROM steward_state",
					)[0]!.quiet_steps,
				),
			).toEqual({ quiet: { "consolidate-memory": 2 } });
		} finally {
			await upgraded.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("steward/0007 drops the upkeep and the per-exchange judgments, ends the reflecting units made for events and adds the sleep layer's tables", async () => {
	const dir = mkdtempSync(join(tmpdir(), "steward-0007-"));
	const path = join(dir, "db.sqlite3");
	try {
		const old = openStore(path, [
			...conversationMigrations,
			...stewardMigrations.slice(0, 6),
		]);
		await old.write((db) => {
			const unit = db.query(
				`INSERT INTO steward_unit (id, conversation_id, kind, step, slot, targets, state, created_at, closed_at)
				 VALUES (?,?,?,?,?,?,?,?,?)`,
			);
			unit.run(
				"u-events",
				"c1",
				"events",
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
				"events",
				"curate-memory",
				"reflect",
				"{}",
				"applied",
				"t2",
				"t3",
			);
			unit.run(
				"u-world",
				"c1",
				"world_events",
				"curate-world",
				"world",
				"{}",
				"open",
				"t4",
				null,
			);
			unit.run(
				"u-upkeep",
				"c1",
				"maintenance",
				"consolidate-memory",
				"maintenance",
				"{}",
				"applied",
				"t5",
				"t6",
			);
			db.query(
				"INSERT INTO steward_inbox (id, conversation_id, source_ref, kind, what, state, created_at) VALUES ('r1','c1','m1','forget','住所','pending','t')",
			).run();
			db.query(
				"INSERT INTO steward_decision (id, conversation_id, job_id, step, created_at) VALUES (1,'c1','j1','consolidate-memory','t'), (2,'c1','j2','curate-memory','t')",
			).run();
			db.query(
				"INSERT INTO steward_decision_ref (decision_id, ref_type, ref_id) VALUES (1,'item','i1'), (2,'message','m1')",
			).run();
			db.query(
				"INSERT INTO steward_state (conversation_id) VALUES ('c1')",
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
				rows("SELECT id, kind, slot, state FROM steward_unit ORDER BY id"),
			).toEqual([
				{ id: "u-done", kind: "requests", slot: "reflect", state: "applied" },
				{ id: "u-events", kind: "requests", slot: "reflect", state: "stale" },
				{ id: "u-world", kind: "world_events", slot: "world", state: "open" },
			]);
			expect(rows("SELECT id FROM steward_decision")).toEqual([{ id: 2 }]);
			expect(rows("SELECT ref_id FROM steward_decision_ref")).toEqual([
				{ ref_id: "m1" },
			]);
			expect(
				rows(
					"SELECT name FROM sqlite_master WHERE name IN ('steward_state','steward_route','steward_goal_todo','steward_event_failure')",
				),
			).toEqual([]);
			expect(rows("SELECT id, state, exclusion FROM steward_inbox")).toEqual([
				{ id: "r1", state: "pending", exclusion: null },
			]);
			expect(
				rows(
					"SELECT shallow_watermark AS w, deep_day AS d FROM steward_sleep_state",
				),
			).toEqual([{ w: 0, d: null }]);
			// The new kinds and states are accepted.
			await upgraded.write((db) => {
				db.query(
					"INSERT INTO steward_unit (id, conversation_id, kind, step, slot, targets, state, created_at) VALUES ('s','steward:sleep','sleep','deep','maintenance','{}','open','t')",
				).run();
				db.query(
					"UPDATE steward_inbox SET state = 'excluded', exclusion = '{}' WHERE id = 'r1'",
				).run();
			});
		} finally {
			await upgraded.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
