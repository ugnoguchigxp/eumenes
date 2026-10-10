import type { Database } from "bun:sqlite";
import { type Prepared } from "../../capabilities";
import type { ToolRuntime } from "../../tool-runtime";
import type { Task, StoredBinding } from "../contracts";
import { explorationBudget, localTool, operationLimits } from "./exploration";
export function createToolSelection({
	tools,
	bindings,
	prepared,
	storedBinding,
	now,
}: {
	tools: ToolRuntime;
	bindings: Map<string, ReturnType<ToolRuntime["bind"]>>;
	prepared: Map<string, Prepared>;
	storedBinding: (t: Task) => StoredBinding | null;
	now: () => number;
}) {
	/** A cached direct plan permits one acquisition; successful results remain replayable. */
	function toolLimit(t: Task, toolId: string) {
		if (storedBinding(t)?.initialAction.kind === "direct-invoke") return 1;
		const limits = operationLimits(prepared.get(t.id));
		return localTool(toolId)
			? limits.localCalls
			: toolId === "web.lookup"
				? limits.searches
				: toolId === "web.read"
					? limits.reads
					: 1;
	}
	function usableTools(db: Database, t: Task, preparing = false) {
		if (!bindings.get(t.id)?.length || t.error_code === "research_no_progress")
			return [];
		const p = prepared.get(t.id);
		const budget = explorationBudget(
			preparing ? { ...t, model_calls: t.model_calls + 1 } : t,
			p,
			tools.invocationsInTransaction(db, t.id),
			now(),
		);
		if (!budget.canOperate) return [];
		const hasSavedBody = tools
			.observationsInTransaction(db, t.id)
			.some((o) => o.sources.some((s) => s.sourceRef));
		const invocations = tools.invocationsInTransaction(db, t.id);
		return (bindings.get(t.id) ?? []).flatMap((b) => {
			if (["web.find", "web.read_saved"].includes(b.tool.id) && !hasSavedBody)
				return [];
			const replayOnly =
				(localTool(b.tool.id)
					? budget.localCalls >= budget.maxLocalCalls
					: budget.externalCalls >= budget.maxExternalCalls ||
						(b.tool.id === "web.lookup"
							? budget.searches >= budget.maxSearches
							: budget.reads >= budget.maxReads)) ||
				tools.countInTransaction(db, t.id, b.tool.revisionId) >=
					toolLimit(t, b.tool.id);
			if (
				replayOnly &&
				!invocations.some(
					(i) =>
						i.toolRevisionId === b.tool.revisionId &&
						!i.superseded &&
						["succeeded", "partial"].includes(i.state),
				)
			)
				return [];
			return [{ ...b, replayOnly }];
		});
	}

	return { usableTools };
}
