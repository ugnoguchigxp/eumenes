import type { Prepared } from "../../capabilities";
import type { Task } from "../contracts";
export const isHistory = (p: Prepared | undefined) =>
	p?.package.backend === "history";
export const newResearch = (p: Prepared | undefined) =>
	isHistory(p) ||
	!!p?.dependencies.some((d) => d.revisionId === "skill:web.research@6");
export const modelLimit = (p: Prepared | undefined) =>
	isHistory(p) ? 7 : newResearch(p) ? 12 : 8;
export const localTool = (id: string) =>
	["web.find", "web.read_saved", "history.search", "history.read"].includes(id);
export function workerDeadline(
	p: Prepared,
	parentDeadline: number,
	now: number,
) {
	const deadline = Math.min(
		now + (newResearch(p) ? 150000 : 90000),
		parentDeadline - (newResearch(p) ? 30000 : 15000),
	);
	if (deadline <= now) throw new Error("agent_budget_exhausted");
	return deadline;
}
export function stepDeadline(t: Task, p: Prepared | undefined, now: number) {
	return Math.min(
		t.deadline,
		now + (t.kind === "worker" ? (newResearch(p) ? 45000 : 30000) : 15000),
	);
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
		maxLocalCalls: newResearch(p) ? 4 : 0,
		maxExternalCalls: 5,
		maxModelCalls: modelLimit(p),
		canOperate:
			t.model_calls < modelLimit(p) - 1 &&
			t.deadline - now > (newResearch(p) ? 60000 : 5000),
	};
}
