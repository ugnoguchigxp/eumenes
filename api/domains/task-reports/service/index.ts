import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { TasksService } from "../../tasks";
import { reportBodySchema, type ReportBody } from "../contracts";
import * as repo from "../repository";
export function createTaskReports(input: {
	store: SqliteStore;
	tasks: () => TasksService;
	now?: () => number;
}) {
	const now = input.now ?? Date.now;
	function task(db: Database, id: string) {
		const t = input.tasks().getInTransaction(db, id);
		if (!t) throw new Error("task_not_found");
		if (t.bodyExpired || t.forgottenAt) throw new Error("task_history_expired");
		return t;
	}
	return {
		appendInTransaction(
			db: Database,
			taskId: string,
			key: string,
			body: ReportBody,
			observedAt = now(),
		) {
			const t = task(db, taskId),
				data = reportBodySchema.parse(body);
			if (
				!/^[a-zA-Z0-9_.:-]{1,200}$/.test(key) ||
				!Number.isSafeInteger(observedAt) ||
				observedAt > now()
			)
				throw new Error("invalid_task_report");
			const old = repo.find(db, taskId, key);
			if (old) {
				const {
					kind,
					summary,
					facts,
					limitations,
					evidenceRefs,
					snapshotHash,
					questionId,
					git,
				} = old;
				const prior = {
					kind,
					summary,
					facts,
					limitations,
					evidenceRefs,
					snapshotHash,
					questionId,
					git,
				};
				if (JSON.stringify(prior) !== JSON.stringify(data))
					throw new Error("task_report_conflict");
				return old;
			}
			if (
				["completed", "failed", "cancelled", "paused"].includes(data.kind) &&
				t.state !== data.kind
			)
				throw new Error("invalid_task_report_state");
			if (
				data.kind === "blocker" &&
				(!data.questionId ||
					input.tasks().openQuestionInTransaction(db, taskId)?.id !==
						data.questionId)
			)
				throw new Error("invalid_task_report_question");
			return repo.append(db, {
				...data,
				id: crypto.randomUUID(),
				taskId,
				executionGeneration: t.executionGeneration,
				authorityEpoch: t.authorityEpoch,
				taskRevision: t.revision,
				originConversationId:
					t.origin.source === "conversation" ? t.origin.conversationId : null,
				phase: t.phase,
				observedAt,
				createdAt: now(),
				dedupeKey: key,
				priority: data.kind === "progress" ? "normal" : "high",
			});
		},
		supersedeQuestionsInTransaction: repo.supersedeQuestions,
		purgeInTransaction: repo.purge,
		list(taskId: string, after = 0, limit = 50) {
			if (
				!Number.isSafeInteger(after) ||
				after < 0 ||
				!Number.isSafeInteger(limit) ||
				limit < 1 ||
				limit > 100
			)
				throw new Error("invalid_task_report_query");
			return input.store.readSnapshot((db) => {
				task(db, taskId);
				const items = repo.list(db, taskId, after, limit + 1);
				return {
					items: items.slice(0, limit),
					nextCursor: items.length > limit ? items[limit - 1]!.sequence : null,
				};
			});
		},
	};
}
export type TaskReports = ReturnType<typeof createTaskReports>;
