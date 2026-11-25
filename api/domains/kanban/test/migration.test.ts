import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrations } from "../repository";

const insert =
	"INSERT INTO kanban_runs(id,card_id,executor_id,executor_revision,workspace_ref,kind,state,card_revision,title,prompt,body,claude_session_id,project_id,origin,created_at) VALUES(?,'c','claude-code',1,'w','task','queued',1,'t','p','b','s','proj',?,1)";

test("origin 'execution' is accepted after the migration; runs, grants, sequence and indexes survive", () => {
	const db = new Database(":memory:");
	db.exec("PRAGMA foreign_keys=ON");
	try {
		for (const m of migrations.slice(0, -1)) db.exec(m.sql);
		db.query(insert).run("old", "board");
		db.query(insert).run("gone", "conversation");
		db.query("DELETE FROM kanban_runs WHERE id='gone'").run();
		db.query("INSERT INTO kanban_run_git_grants VALUES('old','{}')").run();
		expect(() => db.query(insert).run("e", "execution")).toThrow();
		db.transaction(() => db.exec(migrations.at(-1)!.sql))();
		expect(db.query("SELECT id,seq,origin FROM kanban_runs").all()).toEqual([
			{ id: "old", seq: 1, origin: "board" },
		]);
		expect(
			db.query("SELECT run_id,grant_json FROM kanban_run_git_grants").all(),
		).toEqual([{ run_id: "old", grant_json: "{}" }]);
		expect(
			db
				.query(
					"SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='kanban_runs' AND name LIKE 'kanban_runs_%' ORDER BY name",
				)
				.all(),
		).toEqual([{ name: "kanban_runs_card" }, { name: "kanban_runs_state" }]);
		db.query(insert).run("new", "execution");
		// the deleted row's sequence high-water mark is kept, so seq 2 is not reused
		expect(
			(
				db.query("SELECT seq FROM kanban_runs WHERE id='new'").get() as {
					seq: number;
				}
			).seq,
		).toBe(3);
		expect(() => db.query(insert).run("bad", "other")).toThrow();
		expect(() =>
			db.query("INSERT INTO kanban_run_git_grants VALUES('nope','{}')").run(),
		).toThrow();
		expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
	} finally {
		db.close();
	}
});
