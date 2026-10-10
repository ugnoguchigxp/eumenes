import type { Database } from "bun:sqlite";
import {
	toolRuntimeOf,
	type Prepared,
	type ToolRuntimeMeta,
} from "../../capabilities";
import type { ToolRuntime } from "../../tool-runtime";
import type { Task } from "../contracts";
import {
	explorationBudget,
	isPageRead,
	isSearch,
	localTool,
	operationLimits,
} from "./exploration";
export function createToolSelection({
	tools,
	bindings,
	prepared,
	now,
}: {
	tools: ToolRuntime;
	bindings: Map<string, ReturnType<ToolRuntime["bind"]>>;
	prepared: Map<string, Prepared>;
	now: () => number;
}) {
	function toolLimit(t: Task, meta: ToolRuntimeMeta | undefined) {
		const limits = operationLimits(prepared.get(t.id));
		return localTool(meta)
			? limits.localCalls
			: isSearch(meta)
				? limits.searches
				: isPageRead(meta)
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
			const meta = toolRuntimeOf(b.tool.revisionId);
			if (meta?.requiresSavedBody && !hasSavedBody) return [];
			const replayOnly =
				(localTool(meta)
					? budget.localCalls >= budget.maxLocalCalls
					: budget.externalCalls >= budget.maxExternalCalls ||
						(isSearch(meta)
							? budget.searches >= budget.maxSearches
							: budget.reads >= budget.maxReads)) ||
				tools.countInTransaction(db, t.id, b.tool.revisionId) >=
					toolLimit(t, meta);
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
