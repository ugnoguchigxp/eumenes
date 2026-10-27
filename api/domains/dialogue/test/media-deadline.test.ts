import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { DialogueDeps } from "../service/context";
import { extendMediaDeadline } from "../service/media-deadline";
import { byId } from "../repository";
import { MEDIA_GENERATION_TIMEOUT_MS } from "../../capabilities";

for (const execution of ["image", "music-create"] as const)
	for (const policy of ["default", "explicit", "longer"] as const)
		test(`${execution}: ${policy} deadline survives on-demand startup without overriding caller limits`, () => {
			const db = new Database(":memory:");
			let now = Date.now();
			const initial = now + (policy === "longer" ? 30 * 60_000 : 180_000);
			// Only the run columns used by dispatch and result intake are needed here.
			db.exec(`CREATE TABLE dialogue_runs (
				id TEXT PRIMARY KEY, status TEXT, revision INTEGER, deadline_at TEXT,
				deadline_fixed INTEGER, job_id TEXT, updated_at TEXT, error TEXT,
				answer_message_id TEXT, conversation_id TEXT
			)`);
			db.query("INSERT INTO dialogue_runs VALUES(?,?,?,?,?,?,?,?,?,?)").run(
				"run",
				"running",
				1,
				new Date(initial).toISOString(),
				policy === "explicit" ? 1 : 0,
				null,
				new Date(now).toISOString(),
				null,
				null,
				"main",
			);
			const run = byId(db, "run")!;
			const extended: number[] = [];
			const deps = {
				clock: () => new Date(now).toISOString(),
				larm: {
					extendDeadlineInTransaction: (
						_db: Database,
						_id: string,
						at: number,
					) => extended.push(at),
				},
			} as unknown as DialogueDeps;
			try {
				const result = extendMediaDeadline(deps, db, run, execution, "media");
				const expected =
					policy === "default" ? now + MEDIA_GENERATION_TIMEOUT_MS : initial;
				expect(Date.parse(result.deadlineAt!)).toBe(expected);
				expect(Date.parse(byId(db, run.id)!.deadlineAt!)).toBe(expected);
				expect(extended).toEqual(policy === "default" ? [expected] : []);
				if (policy !== "explicit") {
					now += 4 * 60_000;
					expect(Date.parse(byId(db, run.id)!.deadlineAt!)).toBeGreaterThan(
						now,
					);
				}
			} finally {
				db.close();
			}
		});
