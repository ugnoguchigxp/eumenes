import { expect, test } from "bun:test";
import type { ContextGoalEntry } from "../contracts";
import {
	GOALS_LAYER_MAX_BYTES,
	GOAL_MAX_CHARS,
	goalLine,
	goalsLayerStale,
	renderGoalsLayer,
} from "../service/goals-layer";

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
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const chars = (text: string) => Array.from(text).length;

test("30 goals of 500 Japanese characters stay within 2KB: clipped lines, then one 'ほか N 件' line", () => {
	const goals = Array.from({ length: 30 }, (_, i) =>
		goal(i, { desiredState: `${i}:` + "あ".repeat(500), priority: 30 - i }),
	);
	const layer = renderGoalsLayer(goals)!;
	expect(layer.bytes).toBe(bytes(layer.message.content));
	expect(layer.bytes).toBeLessThanOrEqual(GOALS_LAYER_MAX_BYTES);
	const lines = layer.message.content.split("\n");
	const goalLines = lines.filter(
		(line) => line.startsWith("- ") && !line.startsWith("- ほか"),
	);
	expect(goalLines.length).toBe(layer.shown.length);
	for (const line of goalLines)
		expect(chars(line.slice(2))).toBeLessThanOrEqual(GOAL_MAX_CHARS);
	expect(lines.at(-1)).toBe(`- ほか ${30 - layer.shown.length} 件`);
	// Priority order: the highest priority is the first line.
	expect(layer.shown[0]!.goalId).toBe("g0");
	expect(layer.shown.map((s) => s.goalId)).toEqual(
		layer.shown.map((_, i) => `g${i}`),
	);
});

test("when everything fits there is no 'ほか' line, and no goals gives no layer", () => {
	const layer = renderGoalsLayer([goal(1), goal(2)])!;
	expect(layer.message.content).not.toContain("ほか");
	expect(layer.shown).toHaveLength(2);
	expect(renderGoalsLayer([])).toBeNull();
});

test("priority orders the goals (stable within one priority); a change of priority changes the order, none changes nothing", () => {
	const base = [
		goal(1, { priority: 1 }),
		goal(2, { priority: 5 }),
		goal(3, { priority: 1 }),
	];
	const text = (goals: ContextGoalEntry[]) =>
		renderGoalsLayer(goals)!.message.content;
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

test("a goal line is one line, cut on a character boundary and never splits a surrogate pair", () => {
	expect(goalLine("a\nb\r\n  c")).toBe("- a b c");
	const long = goalLine("😀".repeat(200));
	expect(Array.from(long.slice(2))).toHaveLength(GOAL_MAX_CHARS);
	expect(long.endsWith("…")).toBe(true);
	expect(long).not.toContain("�");
	expect(goalLine("あ".repeat(GOAL_MAX_CHARS))).toBe(
		`- ${"あ".repeat(GOAL_MAX_CHARS)}`,
	);
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
