import type { Prepared } from "../../capabilities";
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
	p?.package.id === "web.quick";
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
export const localTool = (id: string) =>
	["web.find", "web.read_saved", "history.search", "history.read"].includes(id);
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
			localTool(i.toolRevisionId.slice(5).split("@")[0]!),
		).length,
		external = operations.length - local;
	const reads = operations.filter((i) =>
		["web.read", "web.forecast", "web.quote"].includes(
			i.toolRevisionId.slice(5).split("@")[0]!,
		),
	).length;
	const searches = operations.filter((i) =>
		i.toolRevisionId.startsWith("tool:web.lookup@"),
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
