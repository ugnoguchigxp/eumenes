import {
	packageRuntimeOf,
	toolRuntimeOf,
	type Prepared,
	type ToolRuntimeMeta,
} from "../../capabilities";
import type { Task } from "../contracts";
import { guidedWeb } from "./guided-contract";
export const RESEARCH_BUDGET = Object.freeze({
	rootMilliseconds: 180000,
	workerMilliseconds: 150000,
	parentMilliseconds: 30000,
	modelStepMilliseconds: 45000,
	operationReserveMilliseconds: 60000,
	webModelCalls: 12,
	/** The conversation history investigation reaches back over old conversations: more pages, more steps. */
	historyModelCalls: 11,
	historyLocalCalls: 8,
	worldModelCalls: 7,
	localCalls: 4,
	externalCalls: 5,
	searches: 2,
	reads: 3,
});
export const isHistory = (p: Prepared | undefined) =>
	p?.package.backend === "history";
/** The World investigation: reads of the host's own World, like the history route. */
const isWorld = (p: Prepared | undefined) =>
	p?.package.backend === "world-query";
const isRecipeWeb = (p: Prepared | undefined) =>
	!!p && packageRuntimeOf(p.package.id)?.budget === "recipe";
/** The short web confirmation routes: the quick budget, with or without saved procedures. */
export const isQuickWeb = (p: Prepared | undefined) =>
	!!p &&
	["quick", "recipe"].includes(packageRuntimeOf(p.package.id)?.budget ?? "");
export const returnsSearchResults = (p: Prepared | undefined) =>
	!!p && packageRuntimeOf(p.package.id)?.report === "search";
const QUICK_WEB_BUDGET = Object.freeze({
	modelCalls: 5,
	localCalls: 0,
	externalCalls: 2,
	searches: 1,
	reads: 1,
});
/** One saved-procedure lookup, and one extra read when a saved URL fails. */
const RECIPE_WEB_BUDGET = Object.freeze({
	...QUICK_WEB_BUDGET,
	localCalls: 1,
	externalCalls: 3,
	reads: 2,
});
const SEARCH_BUDGET = Object.freeze({ ...RESEARCH_BUDGET, searches: 1 });
export const serviceBudget = (p: Prepared | undefined) =>
	!!p && packageRuntimeOf(p.package.id)?.budget === "service";
export const operationLimits = (p: Prepared | undefined) =>
	serviceBudget(p)
		? { localCalls: 0, externalCalls: 3, searches: 1, reads: 1 }
		: isHistory(p)
			? { ...RESEARCH_BUDGET, localCalls: RESEARCH_BUDGET.historyLocalCalls }
			: guidedWeb(p)
				? {
						...RESEARCH_BUDGET,
						localCalls: 4,
						externalCalls: isQuickWeb(p) ? 6 : 8,
						reads: isQuickWeb(p) ? 4 : 6,
					}
				: isRecipeWeb(p)
					? RECIPE_WEB_BUDGET
					: isQuickWeb(p)
						? QUICK_WEB_BUDGET
						: returnsSearchResults(p)
							? SEARCH_BUDGET
							: RESEARCH_BUDGET;
/** Model calls kept back for the one repair of a research report's verification. */
const repairReserve = 1;
export const modelLimit = (p: Prepared | undefined) =>
	serviceBudget(p)
		? 5
		: isHistory(p)
			? RESEARCH_BUDGET.historyModelCalls
			: isWorld(p)
				? RESEARCH_BUDGET.worldModelCalls
				: isQuickWeb(p)
					? QUICK_WEB_BUDGET.modelCalls
					: RESEARCH_BUDGET.webModelCalls;
/** Reads that stay inside the host (saved bodies, history, World) and use the local-call budget. */
export const localTool = (meta: ToolRuntimeMeta | undefined) =>
	meta?.operation === "saved_read" ||
	meta?.operation === "history" ||
	meta?.operation === "world" ||
	meta?.operation === "recipe";
export const isSearch = (meta: ToolRuntimeMeta | undefined) =>
	meta?.operation === "search";
/** A read of a URL-addressed page: the only reads that use the per-task read limit. */
export const isPageRead = (meta: ToolRuntimeMeta | undefined) =>
	meta?.operation === "read" && !!meta.urlScope;
export function workerDeadline(
	parentDeadline: number,
	now: number,
	packageId?: string,
) {
	const deadline = Math.min(
		now +
			(packageRuntimeOf(packageId ?? "")?.researchMs ??
				RESEARCH_BUDGET.workerMilliseconds),
		parentDeadline - RESEARCH_BUDGET.parentMilliseconds,
	);
	if (deadline <= now) throw new Error("agent_budget_exhausted");
	return deadline;
}
export function stepDeadline(t: Task, now: number, p?: Prepared) {
	return Math.min(
		t.deadline,
		now + (serviceBudget(p) ? 30000 : RESEARCH_BUDGET.modelStepMilliseconds),
	);
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
			// model_calls includes this prepared call. Keep the following finish
			// (and, for research, verification and its one repair) calls without
			// reserving it twice.
			t.model_calls <=
				modelLimit(p) - (returnsSearchResults(p) ? 1 : 2 + repairReserve) &&
			t.deadline - now > RESEARCH_BUDGET.operationReserveMilliseconds,
	};
}
