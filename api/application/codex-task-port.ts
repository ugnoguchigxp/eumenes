import type { Database } from "bun:sqlite";
import type { CodexTasks, CodexAttempt } from "../domains/codex-tasks";
import {
	readWorkspaceGuard,
	markWorkspaceUnknownInTransaction,
	beginWorkspaceReleaseInTransaction,
	finishWorkspaceReleaseInTransaction,
	type KanbanExecutor,
	type KanbanService,
} from "../domains/kanban";
import type { KanbanExecutorPort } from "./kanban-executors";

/** Worker text and model are resolved from registered revisions / saved settings by the host. */
export type CodexExecutionContext = {
	scope: string;
	workerRevision: string;
	workerInstruction: string;
	settingsRevision: number;
	runnerId: string;
	workspaceId: string;
	model: string;
	effort?:
		| "minimal"
		| "low"
		| "medium"
		| "high"
		| "xhigh"
		| "max"
		| "ultra"
		| "persistent";
	deadlineMs: number;
};
export function createCodexTaskPort(options: {
	tasks: CodexTasks;
	scope?: string;
	definition: () => KanbanExecutor;
	contextInTransaction: (tx: Database) => CodexExecutionContext;
	stop: KanbanExecutorPort["stop"];
	now?: () => number;
	git?: Pick<
		KanbanExecutorPort,
		"gitPreviewInTransaction" | "gitGrantInTransaction"
	>;
}): KanbanExecutorPort {
	return {
		...options.git,
		definition: options.definition,
		enqueueInTransaction(tx, dispatch, guardEpoch) {
			const context = options.contextInTransaction(tx);
			if (
				!context.model ||
				!context.workerInstruction ||
				context.deadlineMs <= 0 ||
				context.deadlineMs > 90 * 60_000
			)
				throw new Error("codex_configuration_incomplete");
			if (
				dispatch.mode !== "work" &&
				(!dispatch.git || dispatch.origin !== "board")
			)
				throw new Error("codex_git_grant_required");
			const previous = options.tasks.latestExecutedForCardInTransaction(
				tx,
				context.scope,
				dispatch.cardId,
			);
			if (
				dispatch.kind !== "task" &&
				(!previous?.adopted ||
					previous.workspaceRef !== dispatch.workspaceRef ||
					!previous.receipt?.managedExecutionStopped ||
					previous.state === "unknown" ||
					!previous.receipt.threadId ||
					previous.receipt.threadId !== dispatch.sessionRef)
			)
				throw new Error("codex_continuation_unavailable");
			options.tasks.enqueueInTransaction(tx, {
				scope: context.scope,
				cardId: dispatch.cardId,
				runId: dispatch.runId,
				requestId: dispatch.runId,
				executorRevision: dispatch.executorRevision,
				workspaceRef: dispatch.workspaceRef,
				guardEpoch,
				workerRevision: context.workerRevision,
				settingsRevision: context.settingsRevision,
				runnerId: context.runnerId,
				spec: {
					protocol: "eumenes-codex-sdk/1",
					executionId: dispatch.runId,
					ownerId: dispatch.cardId,
					workspaceId: context.workspaceId,
					prompt: `${context.workerInstruction}\n\n今回の作業依頼:\n${dispatch.prompt}`,
					model: context.model,
					effort: context.effort,
					...(dispatch.git
						? {
								git: {
									grantId: dispatch.git.grantId,
									mode: dispatch.git.mode,
									remoteId: dispatch.git.remoteId,
									files: dispatch.git.files,
									expiresAt: dispatch.git.expiresAt,
								},
							}
						: {}),
					deadline: new Date(
						(options.now ?? Date.now)() + context.deadlineMs,
					).toISOString(),
					...(dispatch.kind === "task" && previous
						? { replacementOf: previous.id }
						: previous?.receipt?.threadId
							? {
									threadId: previous.receipt.threadId,
									continuationOf: previous.id,
								}
							: {}),
				},
			});
		},
		cancelQueuedInTransaction(tx, id) {
			const scope = options.scope ?? options.contextInTransaction(tx).scope;
			const attempt = options.tasks.attemptInTransaction(tx, scope, id);
			if (!attempt) return false;
			const executed = options.tasks.latestExecutedForCardInTransaction(
				tx,
				scope,
				attempt.cardId,
			);
			if (!options.tasks.cancelQueuedInTransaction(tx, id)) return false;
			if (!executed) {
				const guard = readWorkspaceGuard(tx, attempt.workspaceRef);
				if (
					guard?.ownerRef === `kanban:${attempt.cardId}` &&
					guard.epoch === attempt.guardEpoch &&
					beginWorkspaceReleaseInTransaction(tx, guard)
				)
					finishWorkspaceReleaseInTransaction(tx, guard, true);
			}
			return true;
		},
		stop: options.stop,
	};
}

/** Result, shared card and notification are adopted in the caller's single writer transaction. */
export function adoptCodexTaskInTransaction(
	tx: Database,
	kanban: KanbanService,
	executorId: string,
	attempt: CodexAttempt,
) {
	const guard = readWorkspaceGuard(tx, attempt.workspaceRef);
	if (
		!guard ||
		guard.ownerRef !== `kanban:${attempt.cardId}` ||
		guard.executorId !== executorId ||
		guard.epoch !== attempt.guardEpoch ||
		guard.state !== "held"
	)
		throw new Error("codex_workspace_owner_mismatch");
	const receipt = attempt.receipt;
	if (!receipt) return;
	const state =
		receipt.state === "succeeded"
			? "completed"
			: ["failed", "blocked"].includes(receipt.state) ||
				  (receipt.state === "cancelled" && receipt.reason !== "not_started")
				? "blocked"
				: receipt.state === "accepted" || receipt.state === "starting"
					? "dispatched"
					: receipt.state;
	const facts = {
		runId: attempt.runId,
		executorId,
		executorRevision: attempt.executorRevision,
		attemptRef: attempt.id,
		sessionRef: receipt.threadId,
		executionStopped: receipt.managedExecutionStopped,
	};
	if (["completed", "blocked", "cancelled", "unknown"].includes(state)) {
		if (
			state !== "unknown" &&
			receipt.managedExecutionStopped &&
			!receipt.workspaceHeld
		) {
			if (
				!beginWorkspaceReleaseInTransaction(tx, guard) ||
				!finishWorkspaceReleaseInTransaction(tx, guard, true)
			)
				throw new Error("codex_workspace_release_failed");
		}
		const adopted = kanban.finishExecutionInTransaction(tx, {
			...facts,
			state: state as "completed" | "blocked" | "cancelled" | "unknown",
			report: receipt.report,
			reason: receipt.reason,
			git:
				attempt.spec.git && receipt.git
					? { ...receipt.git, mode: attempt.spec.git.mode }
					: undefined,
		});
		if (state === "unknown") markWorkspaceUnknownInTransaction(tx, guard);
		return adopted;
	} else
		kanban.observeExecutionInTransaction(tx, {
			...facts,
			state: state as "dispatched" | "running" | "settling" | "stopping",
		});
}
