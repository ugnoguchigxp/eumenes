import type { SqliteStore } from "../infrastructure/sqlite";
import type { Database } from "bun:sqlite";
import type { TasksService, OrchestrationWorkTask } from "../domains/tasks";
import type { DelegationPort } from "../domains/dialogue";
import type { ConversationService } from "../domains/conversation";
import { createInbox } from "../domains/dots";
import type { Capabilities } from "../domains/capabilities";
import type { Run } from "../domains/dialogue/contracts";
export function createDotsDialogue(input: {
	store: SqliteStore;
	tasks: TasksService;
	conversation: ConversationService;
	capabilities: Capabilities;
	now?: () => number;
}): DelegationPort {
	const { tasks, conversation, capabilities } = input,
		now = input.now ?? Date.now,
		inbox = createInbox(now);
	const receipt = inbox.dialogueReceiptInTransaction;
	function catalog(db: Database, run: Run) {
		const registered = inbox
			.projectsInTransaction(db)
			.filter(
				(p) =>
					p.enabled &&
					inbox.connectionInTransaction(db, p.connectionRef)?.enabled,
			);
		const projects = registered.flatMap((p) => {
			try {
				const pack = capabilities.prepareActiveByIdInTransaction(
					db,
					{ rootRunId: run.id, taskId: run.id, cancelEpoch: run.revision },
					p.capabilityRevisionId,
					{},
				);
				return [
					{
						ref: p.ref,
						title: p.title,
						revision: p.revision,
						connectionRef: p.connectionRef,
						connectionRevision: inbox.connectionInTransaction(
							db,
							p.connectionRef,
						)!.revision,
						capability: {
							revisionId: pack.package.revisionId,
							hash: pack.package.hash,
							generation: pack.package.generation,
						},
						allowedOperations: p.allowedOperations,
					},
				];
			} catch {
				return [];
			}
		});
		const work = tasks
			.conversationInTransaction(db, run.conversationId, 50)
			.filter(
				(t): t is OrchestrationWorkTask =>
					t.kind === "orchestration" && !t.bodyExpired && !t.forgottenAt,
			);
		return {
			projects,
			tasks: work.map((t) => ({
				ref: t.id,
				title: t.title,
				state: t.state,
				revision: t.revision,
				question: tasks.openQuestionInTransaction(db, t.id)
					? { id: tasks.openQuestionInTransaction(db, t.id)!.id }
					: null,
				result: t.result
					? {
							summary: t.result.summary.slice(0, 600),
							summaryTruncated: t.result.summary.length > 600,
						}
					: null,
			})),
		};
	}
	return {
		prepareInTransaction(db, run) {
			const targets = catalog(db, run);
			return {
				catalog: targets,
				receipt: receipt(db, run.id),
				available: targets.projects.length > 0 || targets.tasks.length > 0,
			};
		},
		invokeInTransaction(db, run, command, snapshot) {
			if (!["manual", "voice"].includes(run.sourceKind) || run.agentTaskId)
				throw new Error("dots_permission_denied");
			const original = conversation.messageInTransaction(
				db,
				run.inputMessageId,
			)?.message;
			if (
				!original ||
				original.conversationId !== run.conversationId ||
				original.role !== "user"
			)
				throw new Error("dots_permission_denied");
			const old = receipt(db, run.id);
			if (old) return old;
			const current = catalog(db, run),
				selected = snapshot as typeof current;
			let saved: unknown;
			if (command.operation === "start") {
				const p = current.projects.find((p) => p.ref === command.projectRef),
					before = selected?.projects?.find(
						(p) => p.ref === command.projectRef,
					);
				if (!p || !before || JSON.stringify(p) !== JSON.stringify(before))
					throw new Error("dots_stale");
				if (!command.operations.every((op) => p.allowedOperations.includes(op)))
					throw new Error("dots_permission_denied");
				saved = tasks.createInTransaction(
					db,
					{
						requestId: crypto.randomUUID(),
						kind: "orchestration",
						version: 1,
						title: command.title,
						request: command.request,
						completionConditions: command.completionConditions,
						startMode: "start",
						grant: {
							connectionRef: p.connectionRef,
							projectRef: p.ref,
							operations: command.operations,
							maxSessions: command.maxSessions,
							expiresAt: new Date(now() + 7200000).toISOString(),
						},
					},
					{
						origin: {
							source: "conversation",
							conversationId: run.conversationId,
							messageId: run.inputMessageId,
							runId: run.id,
							operationKey: "dots:0",
						},
					},
				);
			} else {
				const t = current.tasks.find((t) => t.ref === command.taskRef),
					before = selected?.tasks?.find((t) => t.ref === command.taskRef);
				if (!t || !before || before.revision !== t.revision)
					throw new Error("dots_stale");
				saved =
					command.operation === "inspect"
						? {
								task: tasks.getInTransaction(db, t.ref),
								sessions: inbox.sessionsInTransaction(db, t.ref),
								question: tasks.openQuestionInTransaction(db, t.ref),
							}
						: command.operation === "answer"
							? tasks.answerInTransaction(db, t.ref, {
									requestId: crypto.randomUUID(),
									expectedRevision: t.revision,
									questionId: command.questionId,
									answer: command.answer,
								})
							: tasks.requestStopInTransaction(db, t.ref, {
									requestId: crypto.randomUUID(),
									expectedRevision: t.revision,
									intent: command.intent,
								});
			}
			const result = {
				operation: command.operation,
				receipt: saved,
				verification: "registered_in_eumenes",
			};
			inbox.saveDialogueReceiptInTransaction(
				db,
				run.id,
				run.conversationId,
				command.operation === "start"
					? (saved as { taskId: string }).taskId
					: command.taskRef,
				result,
			);
			return result;
		},
	};
}
