import type { Database } from "bun:sqlite";
import type { DialogueService } from "../../domains/dialogue";
import type { ChildExecution, ChildResult } from "../../domains/tool-runtime";
import type { TaskQuestion } from "../../domains/tasks";

/** Registered legacy backends keep their existing consent, snapshot and task ownership checks. */
export interface TaskLegacyPorts {
	availableInTransaction(
		db: Database,
		kind: "object-recognition" | "dots",
		revisionId: string,
		sourceRunId?: string,
	): boolean;
	invokeInTransaction(
		db: Database,
		child: ChildExecution,
		prepared: Parameters<DialogueService["executionCommands"]["execute"]>[0],
		command: unknown,
	): ChildResult;
	currentInTransaction(
		db: Database,
		child: ChildExecution,
		ref: unknown,
	): ChildResult;
	cancelInTransaction(db: Database, child: ChildExecution, ref: unknown): void;
	validateAnswerInTransaction(
		db: Database,
		child: ChildExecution,
		ref: unknown,
		input: unknown,
	): boolean;
}
export function taskLegacyPorts(dialogue: DialogueService): TaskLegacyPorts {
	const commands = dialogue.executionCommands;
	function currentInTransaction(
		db: Database,
		child: ChildExecution,
		raw: unknown,
	): ChildResult {
		const ref = raw as {
			kind: "legacy";
			type: string;
			taskId?: string;
			receipt?: unknown;
		};
		const task = ref.taskId
			? (commands.legacyTaskInTransaction(
					db,
					child.source.conversationId,
					ref.taskId,
				) as {
					state: string;
					result?: unknown;
					bodyExpired?: boolean;
					forgottenAt?: string;
					question?: TaskQuestion | null;
				} | null)
			: null;
		const state =
			!task || task.bodyExpired || task.forgottenAt
				? "failed"
				: ["completed", "cancelled", "failed"].includes(task.state)
					? (task.state as "completed" | "cancelled" | "failed")
					: "running";
		return {
			state:
				task?.state === "waiting_user" && task.question
					? "waiting_input"
					: state,
			ref: task?.question ? { ...ref, questionId: task.question.id } : ref,
			...(task?.state === "waiting_user" && task.question
				? {
						question: task.question.prompt,
						questionSchema: {
							type: "string",
							minLength: 1,
							maxLength: 8000,
							...(task.question.answerType === "choice"
								? { enum: task.question.choices }
								: {}),
						},
					}
				: {}),
			output: task,
			summary: JSON.stringify(
				task ?? { errorCode: "delegation_result_unavailable" },
			).slice(0, 2000),
			modelCalls: (child.usedModelCalls ?? 0) + 1,
			references: [],
		};
	}
	return {
		availableInTransaction: (db, kind, _revision, runId) =>
			commands.legacyAvailableInTransaction(db, kind, runId ?? ""),
		invokeInTransaction(db, child, prepared, command) {
			const receipt = commands.invokeLegacyInTransaction(
				db,
				child,
				prepared,
				command,
			);
			const ref = { kind: "legacy" as const, type: prepared.backend, receipt };
			const output = receipt as {
				state?: string;
				receipt?: { taskId?: string; id?: string };
				operation?: string;
			} | null;
			if (prepared.backend === "object-recognition")
				return {
					state: ["read", "cancel"].includes(
						(receipt as { action?: string } | null)?.action ?? "",
					)
						? "completed"
						: "handoff",
					ref,
					output: receipt,
					summary: JSON.stringify(receipt),
					...(["read", "cancel"].includes(
						(receipt as { action?: string } | null)?.action ?? "",
					)
						? {}
						: { code: "interactive_handoff" }),
					modelCalls: (child.usedModelCalls ?? 0) + 1,
					references: [],
				};
			const taskId =
				output?.receipt?.taskId ??
				output?.receipt?.id ??
				(command as { taskRef?: string }).taskRef;
			if (taskId) return currentInTransaction(db, child, { ...ref, taskId });
			return {
				state: "failed",
				ref: { ...ref, taskId },
				output: receipt,
				summary: JSON.stringify(receipt).slice(0, 2000),
				modelCalls: (child.usedModelCalls ?? 0) + 1,
				references: [],
			};
		},
		currentInTransaction,
		validateAnswerInTransaction(db, child, raw, input) {
			const ref = raw as { taskId?: string; questionId?: string } | null;
			if (
				!ref?.taskId ||
				typeof input !== "string" ||
				!input.trim() ||
				input.length > 8000
			)
				return false;
			const current = currentInTransaction(db, child, ref);
			const task = current.output as { question?: TaskQuestion } | null;
			return (
				current.state === "waiting_input" &&
				!!task?.question &&
				task.question.id === ref.questionId &&
				(task.question.answerType === "text" ||
					task.question.choices.includes(input))
			);
		},
		cancelInTransaction(db, child, raw) {
			const ref = raw as { taskId?: string } | null;
			if (ref?.taskId)
				commands.cancelLegacyTaskInTransaction(
					db,
					child.source.conversationId,
					ref.taskId,
				);
		},
	};
}
