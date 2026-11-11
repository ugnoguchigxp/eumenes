import type { WebNoteService } from "../../domains/web-note";
import type { DomainAdapter } from "../../domains/tool-runtime";

export function describeWebNoteAdapter() {
	return {
		owner: "web-note",
		operations: new Map(),
		queries: new Set<string>(),
		inputAdapters: new Map(),
		projections: new Set<string>(),
		availability: "availability:web-note@1",
		task: true,
		// A note only reads the public Web.
		autonomy: "read" as const,
	};
}
/** Registered lifecycle; the dialogue's common task path and the agency's research select this owner. */
export function createWebNoteAdapter(
	service: () => WebNoteService | undefined,
	enabled = true,
): DomainAdapter {
	const required = () => {
		const value = service();
		if (!value) throw new Error("web_note_unavailable");
		return value;
	};
	return {
		ref: "adapter:web-note@1",
		describe: describeWebNoteAdapter,
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
