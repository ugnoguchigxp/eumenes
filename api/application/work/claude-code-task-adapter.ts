import {
	adapterRef,
	type ClaudeCodeService,
	type Host,
} from "../../domains/claude-code";
import {
	beginWorkspaceReleaseInTransaction,
	finishWorkspaceReleaseInTransaction,
	readWorkspaceGuard,
	reserveWorkspaceInTransaction,
} from "../../domains/kanban";
import type { DomainAdapter } from "../../domains/tool-runtime";

export function describeClaudeCodeTaskAdapter() {
	return {
		owner: "claude-code",
		operations: new Map(),
		queries: new Set<string>(),
		inputAdapters: new Map(),
		projections: new Set<string>(),
		availability: "availability:claude-code-task@1",
		task: true,
	};
}

export function createClaudeCodeTaskAdapter(
	service: () => ClaudeCodeService | undefined,
): DomainAdapter {
	const required = () => {
		const task = service()?.task;
		if (!task) throw new Error("claude_task_unavailable");
		return task;
	};
	return {
		ref: adapterRef,
		describe: describeClaudeCodeTaskAdapter,
		availableInTransaction: () => service()?.availableInTransaction() ?? false,
		artifactAvailableInTransaction: () => false,
		task: {
			startInTransaction: (db, input) =>
				required().startInTransaction(db, input),
			controlInTransaction: (db, conversationId, input, messageId) =>
				required().controlInTransaction(db, conversationId, input, messageId),
			viewInTransaction: (db, id) =>
				service()?.task.viewInTransaction(db, id) ?? null,
			cancelInTransaction: (db, conversationId, id) =>
				required().cancelInTransaction?.(db, conversationId, id),
			forgetInTransaction: (db, id) => required().forgetInTransaction?.(db, id),
		},
		invokeInTransaction: () => {
			throw new Error("task_lifecycle_required");
		},
		snapshotInTransaction: () => null,
		readInTransaction: () => null,
		sourceInTransaction: () => null,
		targetInput: () => ({}),
		afterCommit: () => service()?.flush(),
	};
}

export function claudeWorkspace(workspaceRef: string): Host["workspace"] {
	const executorId = "claude-code-task";
	const owner = (workId: string) => `claude-code-work:${workId}`;
	return {
		hold(db, workId) {
			return reserveWorkspaceInTransaction(db, {
				workspaceRef,
				ownerRef: owner(workId),
				executorId,
				epoch: workId,
				state: "held",
			});
		},
		release(db, workId, confirmed) {
			const guard = readWorkspaceGuard(db, workspaceRef);
			if (
				guard?.ownerRef === owner(workId) &&
				guard.executorId === executorId &&
				beginWorkspaceReleaseInTransaction(db, guard)
			)
				finishWorkspaceReleaseInTransaction(db, guard, confirmed);
		},
	};
}
