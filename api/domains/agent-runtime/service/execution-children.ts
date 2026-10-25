import type { Database } from "bun:sqlite";
import { hash, type Owner } from "../../capabilities";
import type { ChildExecution } from "../../tool-runtime";
import { byExecutionCall, get } from "../repository";
import {
	executionRow,
	executionState,
	isExecutionActive,
} from "../repository/executions";
import type { Answer } from "./answer";
import { linksOfTree } from "./resource-access";
import type { RuntimeContext } from "./runtime-context";
import type { TaskOps } from "./task-ops";

export function activeExecutionChild(db: Database, child: ChildExecution) {
	const row = executionRow(db, child.executionId);
	return (
		!!row &&
		isExecutionActive(row) &&
		row.request_revision === child.revision &&
		row.deadline > Date.now() &&
		executionState(row).pending?.child.id === child.id
	);
}
export const reservedExecutionCalls = (db: Database, taskId: string) =>
	(
		db
			.query(
				"SELECT COALESCE(SUM(allocation),0) AS n FROM agent_execution_model_reservations WHERE task_id=?",
			)
			.get(taskId) as { n: number }
	).n;

/** Public operations for a child tree. The real conversation run remains its source identity. */
export function executionChildren(
	ctx: RuntimeContext,
	answer: Answer,
	ops: TaskOps,
) {
	function read(db: Database, callId: string) {
		const root = byExecutionCall(db, callId);
		if (!root) return null;
		const tasks = db
			.query(
				"SELECT id,model_calls FROM agent_tasks WHERE id=? OR parent_task_id=?",
			)
			.all(root.id, root.id) as { id: string; model_calls: number }[];
		const calls = tasks.reduce(
			(n, t) => n + t.model_calls + reservedExecutionCalls(db, t.id),
			0,
		);
		const action = db
			.query(
				"SELECT operation_id,receipt_digest,payload_json FROM agent_action_results WHERE task_id=?",
			)
			.get(root.id) as {
			operation_id: string;
			receipt_digest: string;
			payload_json: string;
		} | null;
		const report = answer.reportInTransaction(db, root.id);
		// The resources the sub-agent reported as made (`finish.links`), checked when it finished.
		const links = linksOfTree(db, root.id);
		if (root.state !== "ready_for_answer")
			return {
				root,
				calls,
				ticket: null,
				action,
				links,
				reportDigest: report ? hash(report) : null,
			};
		return {
			root,
			calls,
			links,
			ticket: answer.api.prepareAnswerInTransaction(
				db,
				root.root_run_id,
				root.id,
			),
			action,
			reportDigest: report ? hash(report) : null,
		};
	}
	return {
		reserveExecutionCallsInTransaction(
			db: Database,
			owner: Owner,
			reservationId: string,
		): number | undefined {
			const task = get(db, owner.taskId);
			const child = task
				? (JSON.parse(task.input_json ?? "{}").execution as
						| ChildExecution
						| undefined)
				: undefined;
			if (!task || !child) return undefined;
			if (
				!activeExecutionChild(db, child) ||
				task.root_run_id !== owner.rootRunId ||
				task.cancel_epoch !== owner.cancelEpoch
			)
				throw new Error("execution_changed");
			const prior = db
				.query(
					"SELECT allocation FROM agent_execution_model_reservations WHERE id=? AND task_id=?",
				)
				.get(reservationId, task.id) as { allocation: number } | null;
			if (prior) return prior.allocation;
			const allocation = Math.min(
				12,
				child.modelCalls -
					task.model_calls -
					reservedExecutionCalls(db, task.id) -
					1,
			);
			if (allocation < 1) throw new Error("execution_budget_exceeded");
			db.query(
				"INSERT INTO agent_execution_model_reservations VALUES(?,?,?)",
			).run(reservationId, task.id, allocation);
			return allocation;
		},
		executionChildReceiptInTransaction(db: Database, callId: string) {
			const root = byExecutionCall(db, callId);
			const action = root
				? (db
						.query(
							"SELECT operation_id FROM agent_action_results WHERE task_id=?",
						)
						.get(root.id) as { operation_id: string } | null)
				: null;
			return root ? { root, action } : null;
		},
		executionOriginInTransaction(db: Database, owner: Owner) {
			const task = get(db, owner.taskId);
			const child = task
				? (JSON.parse(task.input_json ?? "{}").execution as
						| ChildExecution
						| undefined)
				: undefined;
			if (!child) return null;
			if (!activeExecutionChild(db, child))
				throw new Error("execution_changed");
			return child;
		},
		executionChildInTransaction: read,
		adoptExecutionChildInTransaction(db: Database, callId: string) {
			const result = read(db, callId);
			if (
				!result?.ticket ||
				!answer.api.validAnswerInTransaction(db, result.ticket)
			)
				return false;
			answer.api.completeAnswerInTransaction(db, result.ticket);
			return true;
		},
		validateExecutionReportInTransaction(
			db: Database,
			callId: string,
			digest: string,
		) {
			const root = byExecutionCall(db, callId);
			if (!root || root.state !== "completed") return false;
			const report = answer.reportInTransaction(db, root.id);
			const worker = root.report_task_id ? get(db, root.report_task_id) : null;
			return (
				!!report &&
				hash(report) === digest &&
				!!worker &&
				ctx.deps.tools.validateEvidenceInTransaction(
					db,
					{
						rootRunId: worker.root_run_id,
						taskId: worker.id,
						cancelEpoch: worker.cancel_epoch,
					},
					report.sources,
				)
			);
		},
		cancelExecutionChildInTransaction(db: Database, callId: string) {
			const root = byExecutionCall(db, callId);
			if (root)
				ops.cancelTreeInTransaction(
					db,
					root.root_run_id,
					"execution_cancelled",
					"cancelled",
					root.id,
				);
		},
	};
}
