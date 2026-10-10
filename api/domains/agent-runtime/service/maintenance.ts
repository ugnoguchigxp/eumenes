import type { Task } from "../contracts";
import { deleteReports } from "../repository";
import { deleteRequirementData } from "../repository/requirements";
import type { RuntimeContext } from "./runtime-context";
import type { TaskOps } from "./task-ops";

export function createMaintenance(ctx: RuntimeContext, ops: TaskOps) {
	const { store, tools, now } = ctx.deps;
	const { state } = ctx;
	const { cancelTreeInTransaction } = ops;
	function maintenance(): Promise<void> {
		if (state.maintaining) return state.maintaining;
		if (state.closed) return Promise.resolve();
		state.maintaining = runMaintenance().finally(() => {
			state.maintaining = null;
		});
		return state.maintaining;
	}
	async function runMaintenance() {
		const cutoff = now() - 14 * 86400000;
		const roots = store.read(
			(db) =>
				db
					.query(
						"SELECT * FROM agent_tasks WHERE kind='coordinator' AND state IN ('completed','failed','cancelled','interrupted') AND updated_at<? AND report_state NOT IN ('deleted','expired') LIMIT 100",
					)
					.all(cutoff) as Task[],
		);
		if (roots.length)
			await store.write((db) => {
				for (const root of roots) {
					cancelTreeInTransaction(db, root.root_run_id, "report_deleted");
					db.query(
						"UPDATE agent_tasks SET input_json=NULL,data_epoch=data_epoch+1,report_state='expired' WHERE root_run_id=?",
					).run(root.root_run_id);
					deleteReports(db, root.root_run_id);
					deleteRequirementData(db, root.root_run_id);
					tools.deleteDataInTransaction(db, root.root_run_id);
				}
			});
		const old = store.read(
			(db) =>
				db
					.query(
						"SELECT root_run_id FROM agent_tasks WHERE kind='coordinator' AND state IN ('completed','failed','cancelled','interrupted') AND updated_at<? LIMIT 100",
					)
					.all(now() - 30 * 86400000) as { root_run_id: string }[],
		);
		if (old.length)
			await store.write((db) => {
				for (const root of old) {
					deleteRequirementData(db, root.root_run_id);
					tools.purgeMetadataInTransaction(db, root.root_run_id);
					for (const table of [
						"agent_steps",
						"agent_task_bindings",
						"agent_reports",
					])
						db.query(
							`DELETE FROM ${table} WHERE task_id IN (SELECT id FROM agent_tasks WHERE root_run_id=?)`,
						).run(root.root_run_id);
					db.query("DELETE FROM agent_events WHERE root_run_id=?").run(
						root.root_run_id,
					);
					db.query("DELETE FROM agent_tasks WHERE root_run_id=?").run(
						root.root_run_id,
					);
				}
			});
	}
	return { maintenance };
}
export type Maintenance = ReturnType<typeof createMaintenance>;
