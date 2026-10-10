import { expect, spyOn, test } from "bun:test";
import * as repo from "../repository";
import { observation, setup } from "./fixture";

test("maintenance reads only supervisors of live tasks", async () => {
	const h = await setup();
	await h.observe(observation({ turnFinished: false, childrenStopped: false }));
	await h.store.write((db) => {
		const row = db
			.query("SELECT data_json FROM coding_supervisors WHERE task_id=?")
			.get(h.taskId) as { data_json: string };
		const insert = db.query("INSERT INTO coding_supervisors VALUES(?,?)");
		for (let i = 0; i < 500; i++) {
			db.query(
				"INSERT INTO work_tasks(id,state,data_json,finished_ms) SELECT ?,'completed',data_json,1 FROM work_tasks WHERE id=?",
			).run(`finished-${i}`, h.taskId);
			insert.run(
				`finished-${i}`,
				JSON.stringify({
					...JSON.parse(row.data_json),
					taskId: `finished-${i}`,
				}),
			);
		}
	});
	const get = spyOn(repo, "get");
	h.advance(150000);
	await h.supervision.maintenance();
	expect(get).toHaveBeenCalledTimes(1);
	expect(h.supervision.get(h.taskId)?.monitorHealth).toBe("monitoring_delayed");
	get.mockRestore();
});
