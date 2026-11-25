import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrations } from "../repository";

const insert =
	"INSERT INTO terminal_requests(id,digest,state,owner,target,mode,project_id,task,prompt,origin,created_at,updated_at) VALUES(?,?,'queued','agent','new','work','p','t','x',?,'a','b')";

test("origin 'execution' is accepted after the migration and existing rows and indexes survive", () => {
	const db = new Database(":memory:");
	db.exec("PRAGMA foreign_keys=ON");
	try {
		for (const m of migrations.slice(0, -1)) db.exec(m.sql);
		db.query(insert).run("old", "d", "board");
		expect(() => db.query(insert).run("e", "d2", "execution")).toThrow();
		db.transaction(() => db.exec(migrations.at(-1)!.sql))();
		expect(
			db.query("SELECT id,origin,files_json FROM terminal_requests").all(),
		).toEqual([{ id: "old", origin: "board", files_json: "[]" }]);
		expect(
			db
				.query(
					"SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='terminal_requests' AND name LIKE 'terminal_requests_%' ORDER BY name",
				)
				.all(),
		).toEqual([
			{ name: "terminal_requests_session" },
			{ name: "terminal_requests_state" },
		]);
		db.query(insert).run("new", "d3", "execution");
		expect(() => db.query(insert).run("bad", "d4", "other")).toThrow();
		expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
	} finally {
		db.close();
	}
});
