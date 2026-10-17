import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "../../capabilities";
import { migration, acquisitionMigration } from "../repository";
import {
	readStoredReportProjection,
	reportProjectionInTransaction,
} from "../service/report-projection";

test("diagnostics preserve the exact accepted projection and reject revoked or corrupted reports", () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-projection-"));
	const path = join(dir, "fixture.sqlite");
	const db = new Database(path);
	try {
		db.exec(migration + acquisitionMigration);
		db.query("INSERT INTO agent_tasks(id,kind,root_run_id,state,phase,deadline,created_at,updated_at,report_state) VALUES('worker','worker','run','completed','completed',1,0,0,'available')").run();
		const projection = JSON.stringify({ answer: "確認した値です。", claims: [] });
		db.query("INSERT INTO agent_reports(task_id,report_json,report_digest,created_at,safe_projection_json,safe_projection_digest) VALUES('worker','{}',?,0,?,?)").run(hash({}), projection, hash(JSON.parse(projection)));
		const before = db.query("PRAGMA data_version").get();
		expect(readStoredReportProjection(path, "worker")?.projection).toBe(projection);
		expect(db.query("PRAGMA data_version").get()).toEqual(before);
		db.query("UPDATE agent_tasks SET report_state='deleted'").run();
		expect(() => readStoredReportProjection(path, "worker")).toThrow("report_deleted");
		db.query("UPDATE agent_tasks SET report_state='available',state='cancelled'").run();
		expect(() => reportProjectionInTransaction(db, "worker")).toThrow("report_not_ready");
		db.query("UPDATE agent_tasks SET state='completed'").run();
		db.query("UPDATE agent_reports SET safe_projection_json='{}'").run();
		expect(() => readStoredReportProjection(path, "worker")).toThrow("report_invalidated");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
