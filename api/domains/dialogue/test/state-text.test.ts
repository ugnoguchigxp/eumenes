import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { PlanItem } from "../../continuity";
import type { DialogueDeps } from "../service/context";
import { PLAN_GOAL_TOKENS, planGoalFields } from "../service/state-plans";
import { estimateTextTokens } from "../../../infrastructure/context-budget";
import {
	stateLinesInTransaction,
	stateProjectionInTransaction,
} from "../service/state-text";

/** `## State`: the presented resources, the plans and the goals. The work is the agent's own (its assignments). */
const nowMs = Date.parse("2026-10-29T14:50:00.000Z");
/** The continuity's plan list: what `## State` reads of the plans (every read is the same list here). */
const noPlans = { plans: { listInTransaction: () => [] as PlanItem[] } };
const plansOf = (plans: PlanItem[]) => ({
	plans: { listInTransaction: () => plans },
});
function depsOf() {
	return { continuity: noPlans } as unknown as DialogueDeps;
}

const lines = (deps: DialogueDeps) =>
	stateLinesInTransaction(deps, {} as Database, {
		conversationId: "main",
		nowMs,
		lastAt: null,
		lastAgent: null,
		state: null,
	});

test("the resources the screen presents are named in display order, and none outside the frame", () => {
	const state = stateProjectionInTransaction(depsOf(), {} as Database, {
		conversationId: "main",
		nowMs,
		lastAt: null,
		lastAgent: null,
		state: null,
		run: { sourceKind: "scheduled" } as never,
		screenLines: [
			{ text: "- a4 画像「図 a11」", resource: "a4" },
			{ text: "- a3（直前の返事で示した）", resource: "a3" },
			{ text: "- 画面「a7」" },
			{
				text: "- [設計書](eumenes://documents/30000000-a314-4000-8000-000000000001)",
			},
			{ text: "- a5（表示枠外）", resource: "a5" },
		],
	});
	expect(state.lines.join("\n")).not.toContain("仕事:");
	expect(state.resources).toEqual(["a4", "a3"]);
});

const plan = (text: string, extra: Partial<PlanItem> = {}): PlanItem => ({
	id: text,
	conversationId: "main",
	kind: "plan",
	text,
	dueAt: null,
	state: "open",
	revision: 1,
	createdAt: "2026-10-29T10:00:00.000Z",
	lastTouchedAt: "2026-10-29T10:00:00.000Z",
	evidence: [],
	memoryItemIds: [],
	...extra,
});

test("`## State` lists the plans soonest first with their date and the goals by slot, after the other fields", () => {
	const deps = depsOf();
	Object.assign(deps, {
		continuity: plansOf([
			plan("水曜に歯医者", { dueAt: "2026-11-25" }),
			plan("先週の買い物", {
				dueAt: "2026-10-20",
				state: "awaiting_confirmation",
			}),
		]),
		agency: {
			goalSlotsInTransaction: () => [
				{ slot: 1, text: "毎朝ストレッチを続ける", state: "進行中" },
			],
		},
	});
	const text = lines(deps).join("\n");
	expect(text).toContain(
		"予定:\n- p1 水曜に歯医者（2026-11-25）\n- p2 先週の買い物（2026-10-20、確認待ち）",
	);
	expect(text).toContain("目標:\n- 枠1 毎朝ストレッチを続ける（進行中）");
	expect(text.indexOf("予定:")).toBeLessThan(text.indexOf("目標:"));
});

test("the plans and goals fields share their token bound, and a full list of plans leaves the goals their first line", () => {
	const deps = depsOf();
	Object.assign(deps, {
		continuity: plansOf(
			Array.from({ length: 40 }, (_, i) =>
				plan(`予定の内容その${i + 1}を少し長めに書いたもの`, {
					dueAt: `2026-11-${String((i % 28) + 1).padStart(2, "0")}`,
				}),
			),
		),
		agency: {
			goalSlotsInTransaction: () => [
				{ slot: 1, text: "目標の内容を少し長めに書いたもの", state: "進行中" },
				{
					slot: 2,
					text: "二つ目の目標を少し長めに書いたもの",
					state: "進行中",
				},
			],
		},
	});
	const text = lines(deps).join("\n");
	const fields = text.slice(text.indexOf("予定:"));
	expect(estimateTextTokens(fields)).toBeLessThanOrEqual(PLAN_GOAL_TOKENS);
	expect(fields).toContain("- p1 ");
	expect(fields).not.toContain("- p40 ");
	// The plans did not take the whole bound: the goals' first line has its room.
	expect(fields).toContain("目標:\n- 枠1 ");
});

test("when memory cannot say which topics are suppressed, the plans and goals are not shown", () => {
	const deps = depsOf();
	Object.assign(deps, {
		continuity: plansOf([plan("歯医者", { dueAt: "2026-11-25" })]),
		memory: {
			suppressionsInTransaction: () => {
				throw new Error("memory_blocked");
			},
		},
		agency: {
			goalSlotsInTransaction: () => [
				{ slot: 1, text: "毎朝ストレッチ", state: "進行中" },
			],
		},
	});
	const text = lines(deps).join("\n");
	expect(text).not.toContain("予定:");
	expect(text).not.toContain("目標:");
	expect(text).toContain("今: ");
});

test("a plan or goal that names a topic the user asked not to be brought up is not shown", () => {
	const deps = depsOf();
	Object.assign(deps, {
		continuity: plansOf([plan("元カノと食事"), plan("歯医者")]),
		memory: {
			suppressionsInTransaction: () => ({ terms: ["元カノ"], facts: [] }),
		},
		agency: {
			goalSlotsInTransaction: () => [
				{ slot: 2, text: "元カノに連絡する", state: "進行中" },
			],
		},
	});
	const text = lines(deps).join("\n");
	expect(text).toContain("歯医者");
	expect(text).not.toContain("元カノ");
	expect(text).not.toContain("目標:");
});

test("the plans `## State` shows are named, and `planIds` names them", () => {
	const deps = depsOf();
	const plans = Array.from({ length: 40 }, (_, i) =>
		plan(`予定の内容その${i + 1}を少し長めに書いたもの`, {
			dueAt: `2026-11-${String((i % 28) + 1).padStart(2, "0")}`,
		}),
	);
	Object.assign(deps, { continuity: plansOf(plans) });
	const { lines: shown, planIds } = planGoalFields(deps, {} as Database);
	// The ids are of the plan lines kept within the bound, in the order shown.
	expect(planIds.length).toBe(
		shown.filter((line) => /^- p\d+ /.test(line)).length,
	);
	expect(planIds.length).toBeGreaterThan(0);
	expect(planIds.length).toBeLessThan(plans.length);
	expect(planIds[0]).toBe(plans.find((p) => p.dueAt === "2026-11-01")!.id);
	// Goals have no plan id.
	expect(planGoalFields(depsOf(), {} as Database)).toEqual({
		lines: [],
		planIds: [],
	});
});
