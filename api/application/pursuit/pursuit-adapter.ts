import type { PursuitService } from "../../domains/pursuit";
import type { DomainAdapter } from "../../domains/tool-runtime";

export const PURSUIT_REPORT_QUERY = "query:pursuit.report@1";

export function describePursuitAdapter(version: 1 | 2 = 1) {
	return {
		owner: "pursuit",
		operations: new Map(),
		queries: new Set([PURSUIT_REPORT_QUERY]),
		inputAdapters: new Map(),
		projections: new Set<string>(),
		availability: "availability:pursuit@1",
		task: true,
		autonomy: version === 2 ? ("create" as const) : ("read" as const),
	};
}
/** Registered lifecycle; the dialogue's common task path selects this owner. */
export function createPursuitAdapter(
	service: () => PursuitService | undefined,
	enabled = true,
	version: 1 | 2 = 1,
): DomainAdapter {
	const required = () => {
		const value = service();
		if (!value) throw new Error("pursuit_unavailable");
		return value;
	};
	return {
		ref: `adapter:pursuit@${version}`,
		describe: () => describePursuitAdapter(version),
		availableInTransaction: () =>
			enabled && (service()?.availableInTransaction() ?? false),
		// The historical report artifact remains registered for existing databases.
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

export function createPursuitAdapters(
	service: () => PursuitService | undefined,
	enabled: boolean,
) {
	return ([1, 2] as const).map((version) =>
		createPursuitAdapter(service, enabled, version),
	);
}
