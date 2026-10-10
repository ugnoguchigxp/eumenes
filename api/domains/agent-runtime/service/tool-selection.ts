import type { Database } from "bun:sqlite";
import { researchInput, type Prepared } from "../../capabilities";
import type { ToolRuntime } from "../../tool-runtime";
import type { Task, StoredBinding } from "../contracts";
import { explorationBudget, localTool, newResearch } from "./exploration";
export function createToolSelection({
	tools,
	bindings,
	prepared,
	storedBinding,
	now,
	invocationHint,
}: {
	tools: ToolRuntime;
	bindings: Map<string, ReturnType<ToolRuntime["bind"]>>;
	prepared: Map<string, Prepared>;
	storedBinding: (t: Task) => StoredBinding | null;
	now: () => number;
	invocationHint?: (
		question: string,
	) => { toolId: string; arguments: unknown } | null;
}) {
	/** A cached (direct) plan allows exactly one use of its single granted tool. */
	function toolLimit(t: Task, toolId: string) {
		if (storedBinding(t)?.initialAction.kind === "direct-invoke") return 1;
		return localTool(toolId)
			? 4
			: toolId === "web.lookup"
				? 2
				: toolId === "web.read"
					? 3
					: 1;
	}
	function usableTools(db: Database, t: Task, preparing = false) {
		if (!bindings.get(t.id)?.length) return [];
		const p = prepared.get(t.id);
		const budget = explorationBudget(
			preparing ? { ...t, model_calls: t.model_calls + 1 } : t,
			p,
			tools.invocationsInTransaction(db, t.id),
			now(),
		);
		if (!budget.canOperate) return [];
		const direct = storedBinding(t)?.initialAction.kind === "direct-invoke";
		const input = researchInput.safeParse(prepared.get(t.id)?.input);
		const hint = input.success ? invocationHint?.(input.data.question) : null;
		const hasSavedBody = tools
			.observationsInTransaction(db, t.id)
			.some((o) => o.sources.some((s) => s.sourceRef));
		return (bindings.get(t.id) ?? []).filter(
			(b) =>
				(!["web.find", "web.read_saved"].includes(b.tool.id) || hasSavedBody) &&
				// Structured regional/symbol tools must be applicable to this request.
				// Otherwise keep the search/read path instead of offering a tool the
				// adapter will reject. Exact cached grants retain their own authority.
				(!input.success ||
					!input.data.urls?.length ||
					b.tool.id !== "web.lookup" ||
					(newResearch(p) && !direct)) &&
				(localTool(b.tool.id)
					? budget.localCalls < 4
					: budget.externalCalls < 5 &&
						(b.tool.id === "web.lookup"
							? budget.searches < 2
							: budget.reads < 3)) &&
				(direct ||
					!invocationHint ||
					!["web.forecast", "web.quote"].includes(b.tool.id) ||
					hint?.toolId === b.tool.id) &&
				tools.countInTransaction(db, t.id, b.tool.revisionId) <
					toolLimit(t, b.tool.id),
		);
	}

	return { toolLimit, usableTools };
}
