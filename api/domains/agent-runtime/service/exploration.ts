import {
	packageRuntimeOf,
	toolRuntimeOf,
	type Prepared,
	type ToolRuntimeMeta,
} from "../../capabilities";
import type { Task } from "../contracts";
export const RESEARCH_BUDGET = Object.freeze({
	rootMilliseconds: 180000,
	workerMilliseconds: 150000,
	parentMilliseconds: 30000,
	modelStepMilliseconds: 45000,
	operationReserveMilliseconds: 60000,
	webModelCalls: 12,
	historyModelCalls: 7,
	localCalls: 4,
	externalCalls: 5,
	searches: 2,
	reads: 3,
});
export const isHistory = (p: Prepared | undefined) =>
	p?.package.backend === "history";
export const isQuickWeb = (p: Prepared | undefined) =>
	!!p && packageRuntimeOf(p.package.id)?.budget === "quick";
const QUICK_WEB_BUDGET = Object.freeze({
	modelCalls: 5,
	localCalls: 0,
	externalCalls: 2,
	searches: 1,
	reads: 1,
});
export const operationLimits = (p: Prepared | undefined) =>
	isQuickWeb(p) ? QUICK_WEB_BUDGET : RESEARCH_BUDGET;
export const modelLimit = (p: Prepared | undefined) =>
	isHistory(p)
		? RESEARCH_BUDGET.historyModelCalls
		: isQuickWeb(p)
			? QUICK_WEB_BUDGET.modelCalls
			: RESEARCH_BUDGET.webModelCalls;
/** Reads that stay inside the host (saved bodies, history) and use the local-call budget. */
export const localTool = (meta: ToolRuntimeMeta | undefined) =>
	meta?.operation === "saved_read" || meta?.operation === "history";
export const isSearch = (meta: ToolRuntimeMeta | undefined) =>
	meta?.operation === "search";
/** A read of a URL-addressed page: the only reads that use the per-task read limit. */
export const isPageRead = (meta: ToolRuntimeMeta | undefined) =>
	meta?.operation === "read" && !!meta.urlScope;
export function workerDeadline(parentDeadline: number, now: number) {
	const deadline = Math.min(
		now + RESEARCH_BUDGET.workerMilliseconds,
		parentDeadline - RESEARCH_BUDGET.parentMilliseconds,
	);
	if (deadline <= now) throw new Error("agent_budget_exhausted");
	return deadline;
}
export function stepDeadline(t: Task, now: number) {
	return Math.min(t.deadline, now + RESEARCH_BUDGET.modelStepMilliseconds);
}
export function explorationBudget(
	t: Task,
	p: Prepared | undefined,
	operations: Array<{ toolRevisionId: string; state: string }>,
	now: number,
) {
	const local = operations.filter((i) =>
			localTool(toolRuntimeOf(i.toolRevisionId)),
		).length,
		external = operations.length - local;
	const reads = operations.filter(
		(i) => toolRuntimeOf(i.toolRevisionId)?.operation === "read",
	).length;
	const searches = operations.filter((i) =>
		isSearch(toolRuntimeOf(i.toolRevisionId)),
	).length;
	return {
		localCalls: local,
		externalCalls: external,
		reads,
		searches,
		maxLocalCalls: operationLimits(p).localCalls,
		maxExternalCalls: operationLimits(p).externalCalls,
		maxSearches: operationLimits(p).searches,
		maxReads: operationLimits(p).reads,
		maxModelCalls: modelLimit(p),
		canOperate:
			t.model_calls < modelLimit(p) - 2 &&
			t.deadline - now > RESEARCH_BUDGET.operationReserveMilliseconds,
	};
}
