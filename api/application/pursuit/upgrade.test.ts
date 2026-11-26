import { forgetPursuitReports } from "../../domains/pursuit";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore } from "../../infrastructure/sqlite";
import { migrations as applicationMigrations } from "../migrations";
test("Eumenes upgrades an existing schema 8 pursuit database through its migration runner", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pursuit-vendor-upgrade-"));
	const path = join(dir, "db");
	const added = ["pursuit-core/0009", "pursuit-core/0010"];
	try {
		const old = openStore(
			path,
			applicationMigrations.filter((m) => !added.includes(m.id)),
		);
		try {
			await old.write((db) =>
				db
					.query(
						"INSERT INTO pursuit_runs(id,conversation_id,state,epoch,revision,deadline,step,data_json,created_at,updated_at) VALUES ('existing','conversation','cancelled',0,0,0,1,NULL,0,0)",
					)
					.run(),
			);
		} finally {
			await old.close();
		}
		const upgraded = openStore(path, applicationMigrations);
		try {
			upgraded.readSnapshot((db) => {
				expect(
					db
						.query(
							"SELECT id FROM schema_migrations_v2 WHERE id IN (?,?) ORDER BY id",
						)
						.all(...added),
				).toEqual(added.map((id) => ({ id })));
				expect(
					db.query("SELECT state FROM pursuit_runs WHERE id='existing'").get(),
				).toEqual({ state: "cancelled" });
				expect(
					db.query("SELECT count(*) AS n FROM pursuit_progress").get(),
				).toEqual({ n: 0 });
			});
		} finally {
			await upgraded.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("forgetting a retired research run erases its report and old research records, and leaves the other runs", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pursuit-forget-"));
	const store = openStore(join(dir, "db"), applicationMigrations);
	const removed: string[] = [];
	const notices: string[] = [];
	try {
		await store.write((db) => {
			db.exec(`
INSERT INTO pursuit_pursuit(id,goal,status,revision,input_json,started_at,updated_at)
 VALUES('core','old goal','completed',0,'{}',1,1);
INSERT INTO pursuit_operation(operation_key,kind,digest,pursuit_id,created_at)
 VALUES('pursuit:report:0','start','old-digest','core',1);
INSERT INTO pursuit_runs(id,conversation_id,state,epoch,revision,deadline,step,core_id,data_json,created_at,updated_at)
 VALUES('report','main','completed',0,0,0,1,'core','{}',1,1);
INSERT INTO pursuit_documents(run_id,epoch,id,url,title,text,fetched_at,truncated)
 VALUES('report',0,'doc','https://example.com','title','private content','date',0);
INSERT INTO pursuit_web_operations(id,run_id,epoch,attempt_id,external_id,job_id)
 VALUES('op','report',0,'attempt','source','job');
INSERT INTO pursuit_notices(id,run_id,epoch,ordinal,state) VALUES('notice','report',0,1,'delivered');
INSERT INTO pursuit_runs(id,conversation_id,state,epoch,revision,deadline,step,data_json,created_at,updated_at)
 VALUES('kept','main','completed',0,0,0,1,'{}',1,1);
INSERT INTO pursuit_documents(run_id,epoch,id,url,title,text,fetched_at,truncated)
 VALUES('kept',0,'kept-doc','https://example.com/kept','kept','independent','date',0);
INSERT INTO pursuit_runs(id,conversation_id,state,epoch,revision,deadline,step,data_json,created_at,updated_at)
 VALUES('other','main','completed',0,0,0,1,'{}',1,1);
INSERT INTO pursuit_runs(id,conversation_id,state,epoch,revision,deadline,step,data_json,created_at,updated_at)
 VALUES('note-run','main','completed',0,0,0,1,'{}',1,1);`);
			forgetPursuitReports(
				db,
				["unrelated"],
				1,
				(id) => removed.push(id),
				(id) => notices.push(id),
			);
			expect(removed).toEqual([]);
			forgetPursuitReports(
				db,
				["report"],
				2,
				(id) => removed.push(id),
				(id) => notices.push(id),
			);
			expect(removed).toEqual(["source"]);
			expect(notices).toEqual(["notice"]);
			expect(
				db.query("SELECT goal, forgotten_at FROM pursuit_pursuit").get(),
			).toEqual({ goal: "", forgotten_at: 2 });
			expect(
				db.query("SELECT data_json FROM pursuit_runs WHERE id='report'").get(),
			).toEqual({
				data_json: null,
			});
			expect(
				db
					.query(
						"SELECT count(*) AS n FROM pursuit_documents WHERE run_id='report'",
					)
					.get(),
			).toEqual({ n: 0 });
			expect(
				db.query("SELECT data_json FROM pursuit_runs WHERE id='kept'").get(),
			).toEqual({ data_json: "{}" });
			expect(
				db
					.query(
						"SELECT count(*) AS n FROM pursuit_documents WHERE run_id='kept'",
					)
					.get(),
			).toEqual({ n: 1 });
			expect(
				db.query("SELECT data_json FROM pursuit_runs WHERE id='other'").get(),
			).toEqual({ data_json: "{}" });
			expect(
				db
					.query("SELECT data_json FROM pursuit_runs WHERE id='note-run'")
					.get(),
			).toEqual({ data_json: "{}" });
			forgetPursuitReports(
				db,
				["report"],
				3,
				(id) => removed.push(id),
				(id) => notices.push(id),
			);
			expect(removed).toEqual(["source"]);
			expect(notices).toEqual(["notice"]);
		});
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
