import { expect, test } from "bun:test";
import type { ContextGoalEntry } from "../contracts";
import { renderContext } from "../service/context-render";
import { CONVERSATION_HOST_RULES } from "../service/context-assembly";
import {
	goalLine,
	goalsLayerStale,
	renderGoalsLayer,
} from "../service/goals-layer";

/** The layer as the `current` format writes it: the message right after the system part. */
function layerText(goals: ContextGoalEntry[]) {
	const layer = renderGoalsLayer(goals)!;
	return renderContext(
		{
			stage: "initial",
			persona: { agentName: "", userName: "", persona: "butler" },
			hostRules: CONVERSATION_HOST_RULES,
			stable: [layer.block],
			history: { turns: [] },
			working: [],
			volatile: [],
			input: { role: "user", content: "依頼" },
		},
		"current",
	).messages[1]!.content;
}

const goal = (
	n: number,
	over: Partial<ContextGoalEntry> = {},
): ContextGoalEntry => ({
	goalId: `g${n}`,
	priority: 0,
	desiredState: `目標${n}`,
	revision: 1,
	...over,
});

test("30 goals of 500 Japanese characters are all listed whole, in priority order, with no 'ほか N 件' line", () => {
	const goals = Array.from({ length: 30 }, (_, i) =>
		goal(i, { desiredState: `${i}:` + "あ".repeat(500), priority: 30 - i }),
	);
	const layer = renderGoalsLayer(goals)!;
	const text = layerText(goals);
	const lines = text.split("\n");
	const goalLines = lines.filter((line) => line.startsWith("- "));
	expect(goalLines).toHaveLength(30);
	expect(text).not.toContain("ほか");
	for (const [i, line] of goalLines.entries())
		expect(line).toBe(`- ${i}:${"あ".repeat(500)}`);
	// Priority order: the highest priority is the first line.
	expect(layer.shown).toHaveLength(30);
	expect(layer.shown.map((s) => s.goalId)).toEqual(
		layer.shown.map((_, i) => `g${i}`),
	);
});

test("when everything fits there is no 'ほか' line, and no goals gives no layer", () => {
	const layer = renderGoalsLayer([goal(1), goal(2)])!;
	expect(layerText([goal(1), goal(2)])).not.toContain("ほか");
	expect(layer.shown).toHaveLength(2);
	expect(renderGoalsLayer([])).toBeNull();
});

test("priority orders the goals (stable within one priority); a change of priority changes the order, none changes nothing", () => {
	const base = [
		goal(1, { priority: 1 }),
		goal(2, { priority: 5 }),
		goal(3, { priority: 1 }),
	];
	const text = layerText;
	expect(renderGoalsLayer(base)!.shown.map((s) => s.goalId)).toEqual([
		"g2",
		"g1",
		"g3",
	]);
	// Unchanged goals: byte-identical (the cache holds).
	expect(text(base)).toBe(text(base.map((g) => ({ ...g }))));
	// A revision number is not part of the text.
	expect(text(base)).toBe(text(base.map((g) => ({ ...g, revision: 9 }))));
	// The priority changed: the order and the text change.
	const raised = base.map((g) =>
		g.goalId === "g3" ? { ...g, priority: 9 } : g,
	);
	expect(renderGoalsLayer(raised)!.shown.map((s) => s.goalId)).toEqual([
		"g3",
		"g2",
		"g1",
	]);
	expect(text(raised)).not.toBe(text(base));
});

test("a goal line is one line and is never cut", () => {
	expect(goalLine("a\nb\r\n  c")).toBe("- a b c");
	expect(goalLine("😀".repeat(200))).toBe(`- ${"😀".repeat(200)}`);
	expect(goalLine("あ".repeat(500))).toBe(`- ${"あ".repeat(500)}`);
});

test("stale only when a goal the layer listed no longer exists", () => {
	let existing = new Set(["g1", "g2"]);
	const port = {
		adoptedForContextInTransaction: () => [],
		existingInTransaction: () => existing,
	};
	const db = {} as never;
	const prepared = { goalIds: ["g1", "g2"] };
	expect(goalsLayerStale(port, db, prepared)).toBe(false);
	// A goal that is gone (forgotten) stales the run; others coming and going does not.
	existing = new Set(["g1", "g2", "g3"]);
	expect(goalsLayerStale(port, db, prepared)).toBe(false);
	existing = new Set(["g1", "g3"]);
	expect(goalsLayerStale(port, db, prepared)).toBe(true);
	// An empty layer records nothing: nothing to contradict.
	expect(goalsLayerStale(port, db, undefined)).toBe(false);
	expect(goalsLayerStale(undefined, db, prepared)).toBe(false);
});
