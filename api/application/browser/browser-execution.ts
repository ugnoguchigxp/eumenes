import { z } from "zod";
import type { BrowserService } from "../../domains/browser";
import { CONVERSATION_DEFAULT_PRINCIPAL as OWNER } from "../../domains/conversation/contracts";
import type { DomainAdapter } from "../../domains/tool-runtime";
import type { BrowserEffects } from "./browser-effects";

/** The adapter's immutable receipt identifies the domain task; status never relies on the last five UI rows. */
export function browserExecution(
	service: BrowserService,
	effects: BrowserEffects,
): NonNullable<DomainAdapter["execution"]> {
	const approval = z.strictObject({ approved: z.boolean() });
	const idOf = (operationId: string, kind: string) =>
		operationId.startsWith(`${kind}:`)
			? operationId.slice(kind.length + 1)
			: null;
	return {
		currentInTransaction(db, operationId, child) {
			const taskId = idOf(operationId, "task.start");
			if (taskId) {
				const task = service.taskExecutionResultInTransaction(
					db,
					OWNER,
					taskId,
				);
				if (task.conversationId !== child.source.conversationId)
					throw new Error("origin_invalid");
				const state =
					task.state === "needs_input"
						? "waiting_input"
						: task.state === "completed"
							? "completed"
							: task.state === "failed"
								? "failed"
								: task.state === "indeterminate"
									? "indeterminate"
									: task.state === "cancelled"
										? "cancelled"
										: task.state === "expired"
											? "expired"
											: "running";
				return {
					state,
					ref: { taskId, deadline: task.deadline },
					summary: task.result ?? task.errorCode ?? task.state,
					modelCalls: task.callsMade,
					references: [],
					...(task.errorCode ? { code: task.errorCode } : {}),
					...(state === "waiting_input"
						? {
								question: task.result ?? "操作を続けてよいですか。",
								questionSchema: z.toJSONSchema(approval),
								questionDeadline: task.deadline,
							}
						: {}),
				};
			}
			const captureId = idOf(operationId, "capture.start");
			if (captureId) {
				const capture = service.captureStatusInTransaction(
					db,
					OWNER,
					captureId,
				);
				return {
					state:
						capture.state === "local_ready"
							? "completed"
							: ["cancelled", "failed", "expired"].includes(capture.state)
								? "failed"
								: "running",
					ref: { captureId },
					summary: JSON.stringify(capture),
					output: capture,
					modelCalls: 0,
					references: [],
				};
			}
			const effect = effects.statusInTransaction(db, operationId);
			if (effect && effect.state !== "completed")
				return {
					state: [
						"queued",
						"running",
						"retry_wait",
						"cancel_requested",
					].includes(effect.state)
						? "running"
						: "indeterminate",
					ref: { operationId },
					summary: effect.errorCode ?? effect.state,
					modelCalls: 0,
					references: [],
				};
			return {
				state: "completed",
				ref: { operationId },
				summary: JSON.stringify({ operationId, verified: "domain_receipt" }),
				modelCalls: 0,
				references: [],
			};
		},
		cancelInTransaction(db, operationId) {
			const taskId = idOf(operationId, "task.start");
			if (taskId) {
				service.cancelTaskInTransaction(db, OWNER, taskId);
				effects.enqueueInTransaction(
					db,
					`execution-cancel:${taskId}`,
					OWNER,
					new Date().toISOString(),
					{ kind: "abort_task", taskId },
				);
			}
			const captureId = idOf(operationId, "capture.start");
			if (captureId) {
				service.cancelCaptureInTransaction(db, OWNER, captureId);
				effects.enqueueInTransaction(
					db,
					`execution-cancel:${captureId}`,
					OWNER,
					new Date().toISOString(),
					{ kind: "abort_capture", captureId },
				);
			}
		},
		validateAnswerInTransaction(db, operationId, input) {
			const taskId = idOf(operationId, "task.start");
			if (!taskId || !approval.safeParse(input).success) return false;
			const task = service.taskExecutionResultInTransaction(db, OWNER, taskId);
			return task.state === "needs_input" && Date.now() < task.deadline;
		},
	};
}

/** A resumed physical task preserves the first task's absolute deadline. */
export function browserExecutionDeadline(
	execution: import("../../domains/tool-runtime").ChildExecution,
) {
	const previous = execution.resume?.previous as
		| { result?: { domain?: { deadline?: number } } }
		| undefined;
	return Math.min(
		execution.deadline,
		previous?.result?.domain?.deadline ?? execution.deadline,
	);
}
