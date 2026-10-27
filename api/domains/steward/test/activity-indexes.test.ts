import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations as conversationMigrations } from "../../conversation";
import { migrations } from "../repository";
import { lastClosedUnits } from "../repository/activity";

test("activity indexes upgrade retained history and avoid sorting the history for each closed unit", async () => {
	const directory = mkdtempSync(join(tmpdir(), "steward-activity-indexes-"));
	const path = join(directory, "db.sqlite3");
	let store = openStore(path, [
		...conversationMigrations,
		...migrations.filter((m) => m.id !== "steward/0006-activity-indexes"),
	]);
	try {
		await store.write((db) => {
			const unit = db.query(
				"INSERT INTO steward_unit (id,conversation_id,kind,step,slot,targets,state,job_id,created_at,closed_at) VALUES (?,'main','events','curate-memory','reflect','{}','failed',?,?,?)",
			);
			const decision = db.query(
				"INSERT INTO steward_decision (conversation_id,job_id,step,created_at,error_code) VALUES ('main',?,'curate-memory',?,?)",
			);
			for (let i = 0; i < 300; i++) {
				const at = new Date(i * 1000).toISOString();
				unit.run(`unit-${i}`, `job-${i}`, at, at);
				decision.run(`job-${i}`, at, i > 250 ? "larm_preempted" : "failed");
			}
		});
		const before = store.read((db) =>
			lastClosedUnits(db, "main", ["larm_preempted"]),
		);
		expect(before).toMatchObject([{ jobId: "job-250", errorCode: "failed" }]);
		await store.close();
		store = openStore(path, [...conversationMigrations, ...migrations]);
		store.read((db) => {
			let sql = "";
			const capture = new Proxy(db, {
				get(target, key) {
					if (key === "query")
						return (text: string) => {
							sql = text;
							return target.query(text);
						};
					return Reflect.get(target, key);
				},
			}) as Database;
			expect(lastClosedUnits(capture, "main", ["larm_preempted"])).toEqual(
				before,
			);
			const plan = db
				.query(`EXPLAIN QUERY PLAN ${sql}`)
				.all("main", "larm_preempted") as { detail: string }[];
			// The regression was a repeated sort plus decision scans across the whole conversation.
			expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(
				false,
			);
			expect(
				plan.filter((row) => row.detail.includes("job_id=?")).length,
			).toBeGreaterThanOrEqual(2);
		});
	} finally {
		await store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
