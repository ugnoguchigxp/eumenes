import type { TasksService } from "../../domains/tasks";
import type { DelegationPort } from "../../domains/dialogue";
/** Read/cancel compatibility for already persisted legacy execution refs. New work uses the registered adapter. */
export function createDotsDialogue(input: {
	tasks: TasksService;
}): DelegationPort {
	const { tasks } = input;
	return {
		executionTaskInTransaction(db, conversationId, taskId) {
			const task = tasks.getInTransaction(db, taskId);
			if (
				!task ||
				task.origin.source !== "conversation" ||
				task.origin.conversationId !== conversationId
			)
				return null;
			return {
				...task,
				question: tasks.openQuestionInTransaction(db, taskId),
			};
		},
		cancelExecutionTaskInTransaction(db, conversationId, taskId) {
			const task = tasks.getInTransaction(db, taskId);
			if (
				!task ||
				task.origin.source !== "conversation" ||
				task.origin.conversationId !== conversationId
			)
				return;
			tasks.requestStopInTransaction(db, taskId, {
				requestId: crypto.randomUUID(),
				expectedRevision: task.revision,
				intent: "cancel",
			});
		},
	};
}
