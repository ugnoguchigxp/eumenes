import {
	adapterRef,
	worksAdapterRef,
	type ClaudeCodeService,
	type Host,
} from "../../domains/claude-code";
import {
	beginWorkspaceReleaseInTransaction,
	finishWorkspaceReleaseInTransaction,
	readWorkspaceGuard,
	readWorkspaceGuards,
	recoverWorkspaceReleaseInTransaction,
	reserveWorkspaceInTransaction,
} from "../../domains/kanban";
import type { DomainAdapter } from "../../domains/tool-runtime";

export const ordinaryClaudeWorkspaceRef = "eumenes";

export function describeClaudeCodeTaskAdapter(works = false) {
	return {
		owner: works ? "prototype" : "claude-code",
		operations: new Map(),
		queries: new Set<string>(),
		inputAdapters: new Map(),
		projections: new Set<string>(),
		availability: works
			? "availability:prototype-task@1"
			: "availability:claude-code-task@1",
		task: true,
	};
}

export function createClaudeCodeTaskAdapter(
	service: () => ClaudeCodeService | undefined,
	works = false,
): DomainAdapter {
	const port = () => (works ? service()?.worksTask : service()?.task);
	const required = () => {
		const task = port();
		if (!task) throw new Error("claude_task_unavailable");
		return task;
	};
	return {
		ref: works ? worksAdapterRef : adapterRef,
		describe: () => describeClaudeCodeTaskAdapter(works),
		availableInTransaction: () =>
			(works
				? service()?.worksAvailableInTransaction()
				: service()?.availableInTransaction()) ?? false,
		artifactAvailableInTransaction: () => false,
		task: {
			get inputParameters() {
				return port()?.inputParameters;
			},
			startInTransaction: (db, input) =>
				required().startInTransaction(db, input),
			controlInTransaction: (db, conversationId, input, messageId) =>
				required().controlInTransaction(db, conversationId, input, messageId),
			viewInTransaction: (db, id) => port()?.viewInTransaction(db, id) ?? null,
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

export function claudeWorkspace(
	workspaceRef: string,
	options?: { parallel: boolean },
): Host["workspace"] {
	const executorId = "claude-code-task";
	const owner = (workId: string) => `claude-code-work:${workId}`;
	return {
		hold(db, workId, authorization) {
			if (authorization && authorization.workspaceRef !== workspaceRef)
				return false;
			const slot =
				authorization && options?.parallel
					? authorization.mode === "read"
						? "read"
						: "edit"
					: "exclusive";
			const lease = {
				ownerRef: owner(workId),
				executorId,
				epoch: workId,
				slot,
			} as const;
			const reserved = reserveWorkspaceInTransaction(db, {
				...lease,
				workspaceRef,
				mode: slot,
				state: "held",
			});
			return reserved && authorization ? lease : reserved;
		},
		release(db, workId, confirmed, lease) {
			const guard = readWorkspaceGuard(
				db,
				workspaceRef,
				lease ?? { ownerRef: owner(workId), executorId, epoch: workId },
			);
			if (
				guard?.ownerRef === owner(workId) &&
				guard.executorId === executorId &&
				(guard.state === "releasing" ||
					beginWorkspaceReleaseInTransaction(db, guard))
			)
				finishWorkspaceReleaseInTransaction(db, guard, confirmed);
		},
		released: (db, lease) => !readWorkspaceGuard(db, workspaceRef, lease),
		current(db, lease) {
			const guard = readWorkspaceGuard(db, workspaceRef, lease);
			return guard?.state === "held" && guard.mode === lease.slot;
		},
		blocker(db, workId) {
			const guard = readWorkspaceGuards(db, workspaceRef).find(
				(holder) =>
					holder.ownerRef !== owner(workId) && holder.state !== "held",
			);
			return guard && guard.state !== "held"
				? { ownerRef: guard.ownerRef, state: guard.state }
				: null;
		},
		recover(db, lease) {
			const guard = readWorkspaceGuard(db, workspaceRef, lease);
			return (
				!!guard &&
				guard.mode === lease.slot &&
				recoverWorkspaceReleaseInTransaction(db, guard)
			);
		},
	};
}
