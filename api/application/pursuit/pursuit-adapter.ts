import type { PursuitService } from "../../domains/pursuit";
import type { DomainAdapter } from "../../domains/tool-runtime";

export function describePursuitAdapter() {
	return {
		owner: "pursuit",
		operations: new Map(),
		queries: new Set<string>(),
		inputAdapters: new Map(),
		projections: new Set<string>(),
		availability: "availability:pursuit@1",
		task: true,
	};
}
/** Registered lifecycle; the dialogue's common task path selects this owner. */
export function createPursuitAdapter(
	service: () => PursuitService | undefined,
	enabled = true,
): DomainAdapter {
	const required = () => {
		const value = service();
		if (!value) throw new Error("pursuit_unavailable");
		return value;
	};
	return {
		ref: "adapter:pursuit@1",
		describe: describePursuitAdapter,
		availableInTransaction: () =>
			enabled && (service()?.availableInTransaction() ?? false),
		artifactAvailableInTransaction: () => false,
		task: {
			startInTransaction: (db, input) =>
				required().task.startInTransaction(db, input),
			controlInTransaction: (db, conversationId, input, messageId) =>
				required().task.controlInTransaction(
					db,
					conversationId,
					input,
					messageId,
				),
			viewInTransaction: (db, id) =>
				service()?.task.viewInTransaction(db, id) ?? null,
			cancelInTransaction: (db, conversationId, id) =>
				required().task.cancelInTransaction!(db, conversationId, id),
			forgetInTransaction: (db, id) =>
				required().task.forgetInTransaction!(db, id),
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
