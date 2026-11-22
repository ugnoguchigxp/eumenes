import {
	adapterRef,
	availabilityRef,
	type DevelopmentSupervisionService,
} from "../../domains/development-supervision";
import type { DomainAdapter } from "../../domains/tool-runtime";

export function describeSupervisionAdapter() {
	return {
		owner: "development-supervision",
		operations: new Map(),
		queries: new Set<string>(),
		inputAdapters: new Map(),
		projections: new Set<string>(),
		availability: availabilityRef,
		task: true,
	};
}

export function createSupervisionAdapter(
	service: () => DevelopmentSupervisionService | undefined,
): DomainAdapter {
	const required = () => {
		const task = service()?.task;
		if (!task) throw new Error("supervision_unavailable");
		return task;
	};
	return {
		ref: adapterRef,
		describe: describeSupervisionAdapter,
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
