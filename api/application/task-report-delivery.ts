import type { Database } from "bun:sqlite";
import type { ConversationService } from "../domains/conversation";
import type { TasksService } from "../domains/tasks";
import type { TaskReports } from "../domains/task-reports";
/** The report itself is dots' LLM output. Save it as attributed data, never execute its contents. */
export function createTaskReportDelivery(
	reports: TaskReports,
	tasks: TasksService,
	conversation: ConversationService,
) {
	return (db: Database) => {
		for (const r of reports.pendingInTransaction(db, 50)) {
			const t = tasks.getInTransaction(db, r.taskId);
			if (!t || t.bodyExpired || t.forgottenAt) {
				reports.deliveredInTransaction(db, r.id);
				continue;
			}
			if (
				t.authorityEpoch !== r.authorityEpoch ||
				t.executionGeneration !== r.executionGeneration
			) {
				reports.deliveredInTransaction(db, r.id);
				continue;
			}
			conversation.appendInTransaction(db, {
				id: `task-report:${r.id}`,
				conversationId: r.originConversationId!,
				role: "assistant",
				text: [
					`作業報告：${t.title}`,
					r.summary,
					...r.facts,
					...r.limitations,
					...(r.questionId
						? [tasks.openQuestionInTransaction(db, t.id)?.prompt ?? ""]
						: []),
				]
					.filter(Boolean)
					.join("\n\n"),
				createdAt: new Date().toISOString(),
				runId: null,
			});
			reports.deliveredInTransaction(db, r.id);
		}
	};
}
