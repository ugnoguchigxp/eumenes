import type { Database } from "bun:sqlite";
import type { Owner, Prepared } from "../../capabilities";
import type { Task } from "../contracts";
import { get, byRoot, dto } from "../repository";
import type { Answer } from "./answer";
import { safeCode } from "./control-output";
import { active, type RuntimeContext } from "./runtime-context";

export function createQueries(ctx: RuntimeContext, answer: Answer) {
	const { store, capabilities, tools, inference, now } = ctx.deps;
	const { prepared } = ctx.state;
	const { reportInTransaction } = answer;
	return {
		authorizeReadOwnerInTransaction(
			db: Database,
			input: Owner,
			stage: "read" | "adopt",
		) {
			const task = get(db, input.taskId),
				root = byRoot(db, input.rootRunId);
			if (
				!task ||
				!root ||
				task.root_run_id !== input.rootRunId ||
				task.cancel_epoch !== input.cancelEpoch ||
				task.kind !== "worker" ||
				root.deadline <= now() ||
				!["waiting_child", "ready_for_answer"].includes(root.state) ||
				(stage === "read" && (!active(task) || task.deadline <= now())) ||
				["cancelled", "failed", "interrupted"].includes(task.state)
			)
				throw new Error("source_ref_invalid");
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
		conversationContextInTransaction(db: Database, rootRunId: string) {
			let snapshot: unknown;
			let timerCapability: Prepared | undefined;
			if (tools.actionsEnabled()) {
				try {
					const p = capabilities.prepareActiveByIdInTransaction(
						db,
						{ rootRunId, taskId: rootRunId, cancelEpoch: 0 },
						"package:timers.manage@1",
						{ operation: "list" },
					);
					timerCapability = p;
					snapshot = tools.actionContextInTransaction(db, {
						rootRunId,
						taskId: rootRunId,
						cancelEpoch: 0,
					});
				} catch (e) {
					if (
						!["capability_unavailable", "capability_revoked"].includes(
							safeCode(e),
						)
					)
						throw e;
				}
			}
			return {
				timers: snapshot,
				lunaEnabled: inference.codexResearchAvailable?.() ?? false,
				timersEnabled: !!timerCapability,
				timerCapability,
				requirementCatalog: capabilities.requirementCatalogInTransaction(db),
			};
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
