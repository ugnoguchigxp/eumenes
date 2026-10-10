import type { Database } from "bun:sqlite";
import { activeCoordinators, deleteReports } from "../repository";
import { deleteRequirementData } from "../repository/requirements";
import { failureCode, type RuntimeContext } from "./runtime-context";
import type { Maintenance } from "./maintenance";
import type { Reconcile } from "./reconcile";
import type { TaskOps } from "./task-ops";

export function createLifecycle(
	ctx: RuntimeContext,
	ops: TaskOps,
	reconcileApi: Reconcile,
	maintenanceApi: Maintenance,
	flush: () => void,
) {
	const { store, tools, log } = ctx.deps;
	const {
		traceIds,
		traced,
		prepared,
		catalogs,
		actionPrepared,
		bindings,
		reconcileFailures,
	} = ctx.state;
	const { state } = ctx;
	const { timers } = ctx.deps;
	const { cancelTreeInTransaction } = ops;
	const { schedule, reconcile, stop } = reconcileApi;
	const { maintenance } = maintenanceApi;
	return {
		deleteTaskDataInTransaction(
			db: Database,
			rootRunId: string,
			expired = false,
		) {
			cancelTreeInTransaction(db, rootRunId, "report_deleted");
			db.query(
				"UPDATE agent_tasks SET input_json=NULL,data_epoch=data_epoch+1,report_state=? WHERE root_run_id=?",
			).run(expired ? "expired" : "deleted", rootRunId);
			deleteReports(db, rootRunId);
			deleteRequirementData(db, rootRunId);
			tools.deleteDataInTransaction(db, rootRunId);
		},
		async recover() {
			await store.write((db) => {
				const roots = activeCoordinators(db);
				for (const t of roots)
					cancelTreeInTransaction(
						db,
						t.root_run_id,
						"backend_restarted",
						"interrupted",
					);
			});
			flush();
		},
		start() {
			state.started = true;
			schedule();
			state.maintenanceTimer = setInterval(() => {
				void maintenance().catch(() => {
					log.warn("agent.maintenance_failed", {
						reason: "maintenance_failed",
					});
				});
			}, 3600000);
			state.maintenanceTimer.unref();
			void maintenance().catch(() => {
				log.warn("agent.maintenance_failed", { reason: "maintenance_failed" });
			});
		},
		maintenance,
		reconcile() {
			state.dirty = true;
			return reconcile();
		},
		async close() {
			state.closed = true;
			stop();
			if (state.maintenanceTimer) clearInterval(state.maintenanceTimer);
			if (state.timer) clearTimeout(state.timer);
			if (state.retryTimer) clearTimeout(state.retryTimer);
			if (state.throttleTimer) timers.clearTimeout(state.throttleTimer);
			state.throttleTimer = null;
			await state.reconciling?.catch(() => {});
			await state.maintaining?.catch(() => {});
			try {
				await store.write((db) => {
					for (const t of activeCoordinators(db))
						cancelTreeInTransaction(
							db,
							t.root_run_id,
							"backend_stopped",
							"interrupted",
						);
				});
			} catch (error) {
				log.error(
					"agent.close_cancel_failed",
					{ reason: failureCode(error) },
					error,
				);
			}
			flush();
			reconcileFailures.clear();
			prepared.clear();
			catalogs.clear();
			actionPrepared.clear();
			bindings.clear();
			traceIds.clear();
			traced.clear();
			tools.close();
		},
	};
}
