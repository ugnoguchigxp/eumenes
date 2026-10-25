import type { Database } from "bun:sqlite";
import type { Owner } from "../../capabilities";
import type { Task } from "../contracts";
import { get, byRoot, taskRoot, dto } from "../repository";
import type { Answer } from "./answer";
import { active, type RuntimeContext } from "./runtime-context";

export function createQueries(ctx: RuntimeContext, answer: Answer) {
	const { store, capabilities, tools, now } = ctx.deps;
	const { prepared } = ctx.state;
	const { reportInTransaction } = answer;
	return {
		authorizeReadOwnerInTransaction(
			db: Database,
			input: Owner,
			stage: "read" | "adopt",
		) {
			const task = get(db, input.taskId),
				root = task ? taskRoot(db, task) : null;
			const completedExecutionResult =
				stage === "adopt" &&
				root?.state === "completed" &&
				!!(root as Task & { execution_call_id?: string | null })
					.execution_call_id;
			if (
				!task ||
				!root ||
				task.root_run_id !== input.rootRunId ||
				task.cancel_epoch !== input.cancelEpoch ||
				task.kind !== "worker" ||
				(!completedExecutionResult && root.deadline <= now()) ||
				(!completedExecutionResult &&
					!["waiting_child", "ready_for_answer"].includes(root.state)) ||
				(stage === "read" && (!active(task) || task.deadline <= now())) ||
				["cancelled", "failed", "interrupted"].includes(task.state)
			)
				throw new Error("source_ref_invalid");
			const binding = prepared.get(task.id);
			if (stage === "read" && binding)
				capabilities.validateInTransaction(db, binding);
			return { deadline: root.deadline };
		},
		usesViewEvidenceInTransaction(db: Database, taskId: string) {
			return !!get(db, taskId) && prepared.has(taskId);
		},
		resolveRequirementProfilesInTransaction:
			capabilities.resolveRequirementProfilesInTransaction,
		validateActionOwnerInTransaction(db: Database, input: Owner) {
			const task = get(db, input.taskId);
			if (
				!active(task) ||
				task.kind !== "coordinator" ||
				task.phase !== "created" ||
				task.root_run_id !== input.rootRunId ||
				task.cancel_epoch !== input.cancelEpoch
			)
				throw new Error("origin_invalid");
		},
		/**
		 * What a bound operation did for this run, read in the transaction that ran it: the
		 * saved receipt, or the safe code of the refusal. Null while neither exists.
		 */
		actionOutcomeInTransaction(db: Database, rootRunId: string) {
			const root = byRoot(db, rootRunId);
			if (!root) return null;
			const row = db
				.query(
					"SELECT operation_id,receipt_digest FROM agent_action_results WHERE task_id=?",
				)
				.get(root.id) as {
				operation_id: string;
				receipt_digest: string;
			} | null;
			const input = JSON.parse(root.input_json ?? "{}") as {
				command?: { adapterRef?: string };
			};
			if (row && input.command?.adapterRef)
				return {
					state: "saved" as const,
					adapterRef: input.command.adapterRef,
					operationId: row.operation_id,
					digest: row.receipt_digest,
				};
			if (root.error_code)
				return { state: "failed" as const, errorCode: root.error_code };
			return null;
		},
		get(id: string) {
			return store.read((db) => {
				const t = get(db, id);
				return t
					? { ...dto(t), toolOutcomes: tools.summaryInTransaction(db, t.id) }
					: null;
			});
		},
		list(rootRunId: string) {
			return store.read((db) =>
				(
					db
						.query(
							"SELECT * FROM agent_tasks WHERE root_run_id=? ORDER BY created_at,id",
						)
						.all(rootRunId) as Task[]
				).map((t) => ({
					...dto(t),
					toolOutcomes: tools.summaryInTransaction(db, t.id),
				})),
			);
		},
		report(id: string) {
			return store.read((db) => {
				const t = get(db, id);
				if (!t) throw new Error("task_not_found");
				if (["deleted", "expired"].includes(t.report_state))
					throw new Error("report_deleted");
				if (!["completed", "ready_for_answer"].includes(t.state))
					throw new Error("report_not_ready");
				return reportInTransaction(db, id);
			});
		},
	};
}
