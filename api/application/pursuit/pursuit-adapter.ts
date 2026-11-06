import type { PursuitService } from "../../domains/pursuit";
import type { DomainAdapter } from "../../domains/tool-runtime";

export const PURSUIT_REPORT_QUERY = "query:pursuit.report@1";

export function describePursuitAdapter() {
	return {
		owner: "pursuit",
		operations: new Map(),
		queries: new Set([PURSUIT_REPORT_QUERY]),
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
		artifactAvailableInTransaction: () => service() !== undefined,
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
		sourceInTransaction(db, query, targetRef) {
			if (query !== PURSUIT_REPORT_QUERY) return null;
			const view = service()?.reportInTransaction(db, targetRef);
			const result = view?.result;
			if (!view || !result)
				return targetRef !== undefined
					? null
					: {
							revision: 0,
							data: {
								kind: "work-result",
								revision: 0,
								work: {
									title: "調査報告",
									status: "未作成",
									summary:
										"調査の完了後に結果を表示します。調査は会話から依頼できます。",
								},
							},
						};
			return {
				revision: view.revision,
				data: {
					kind: "work-result",
					revision: view.revision,
					targetRef: view.id,
					work: {
						title: "調査報告",
						status: view.status === "completed" ? "完了" : "一部のみ",
						request: view.request,
						summary: result.answer ?? result.summary,
						sections: [
							{
								title: "出典",
								items: (result.sources ?? []).map(
									(s) => `${s.title}\n${s.url}`,
								),
							},
							{
								title: "確認できない点",
								items: result.limitations ?? result.missing,
							},
						],
					},
				},
			};
		},
		targetInput: () => ({}),
		afterCommit: () => service()?.flush(),
	};
}
