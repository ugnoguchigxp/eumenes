import type { AgentRuntime } from "../../domains/agent-runtime";
import type { MarkdownService } from "../../domains/markdown";
import type { DomainAdapter } from "../../domains/tool-runtime";

export const ARCHIVE_RESEARCH_ADAPTER = "adapter:archive-research@1";
export const describeArchiveResearchAdapter = () => ({
	owner: "markdown",
	operations: new Map(),
	queries: new Set<string>(),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:archive-research@1",
	task: true,
});

export function createArchiveResearchAdapter(
	markdown: MarkdownService,
	runtime: () => AgentRuntime | undefined,
): DomainAdapter {
	return {
		ref: ARCHIVE_RESEARCH_ADAPTER,
		describe: describeArchiveResearchAdapter,
		availableInTransaction: (db) =>
			!!markdown.research.binding() &&
			(runtime()?.executions.pipelinesAvailableInTransaction(db) ?? false),
		task: {
			selectedWorker: true,
			startInTransaction(db, input) {
				const agent = runtime();
				if (!agent || !input.toolchainRevisionId || !input.deadline)
					throw new Error("execution_unavailable");
				return agent.executions.startSelectedInTransaction(db, {
					source: input.source,
					request: input.request,
					references: input.references,
					chainRevisionId: input.toolchainRevisionId,
					deadline: input.deadline,
				});
			},
			controlInTransaction(db, conversationId, input, messageId) {
				const agent = runtime();
				if (!agent) throw new Error("execution_unavailable");
				return agent.executions.controlInTransaction(
					db,
					conversationId,
					input,
					messageId,
				);
			},
			viewInTransaction: (db, id) =>
				runtime()?.executions.viewInTransaction(db, id, true) ?? null,
			cancelInTransaction: (db, conversationId, id) =>
				runtime()?.executions.cancelByUserInTransaction(db, conversationId, id),
			forgetInTransaction: (db, id) =>
				runtime()?.executions.forgetInTransaction(db, id),
		},
		invokeInTransaction: () => {
			throw new Error("task_lifecycle_required");
		},
		snapshotInTransaction: () => null,
		readInTransaction: () => null,
		sourceInTransaction: () => null,
		targetInput: () => ({}),
	};
}
