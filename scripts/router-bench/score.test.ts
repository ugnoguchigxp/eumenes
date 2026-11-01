import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MissingPredictions,
	decisionOf,
	genericId,
	main,
	score,
	type Item,
	type Prediction,
} from "./score";

/**
 * The bench scores LARM's predictions through the host's own decision table: ids are generic across turns (`t3.check`
 * is `work.check`), only reviewed items of the split count, and an item with no prediction stops the run.
 */
const THRESHOLDS = {
	accept: 0.6,
	low: 0.3,
	margin: 0.15,
	approve: 0.85,
	multi: 0.5,
};
const item = (
	id: string,
	primary: string,
	extra: Partial<Item> = {},
): Item => ({
	id,
	split: "test",
	gold: { primary, acceptable: [] },
	review: { status: "reviewed" },
	...extra,
});
const prediction = (
	id: string,
	probabilities: Record<string, number>,
	extra: Partial<Prediction> = {},
): Prediction => ({
	id,
	probabilities,
	durationMs: 100,
	revision: "r1",
	...extra,
});

test("the host's ids become the item files' generic ids", () => {
	expect(
		[
			"t3.check",
			"t12.amend",
			"t1.cancel",
			"t3.redirect:music.create",
			"c2.approve",
			"c2.decline",
			"t4.answer",
			"switch.discard",
			"music.create",
			"conversation.respond",
		].map(genericId),
	).toEqual([
		"work.check",
		"work.amend",
		"work.cancel",
		"redirect:music.create",
		"pending.approve",
		"pending.decline",
		"pending.answer",
		"pending.approve",
		"music.create",
		"conversation.respond",
	]);
});

test("a prediction is decided by the product's table: a sure toolchain, a conversation, a question back", () => {
	expect(
		decisionOf(
			prediction("a", { "music.create": 0.8, "conversation.respond": 0.2 }),
			THRESHOLDS,
		),
	).toEqual({ row: 2, id: "music.create", asked: false });
	expect(
		decisionOf(
			prediction("b", { "music.create": 0.1, "conversation.respond": 0.9 }),
			THRESHOLDS,
		),
	).toMatchObject({ row: 1, id: "conversation.respond" });
	expect(
		decisionOf(
			prediction("c", {
				"music.create": 0.29,
				"music.library": 0.28,
				"conversation.respond": 0.22,
				"memory.request": 0.21,
			}),
			THRESHOLDS,
		),
	).toEqual({ row: 8, id: "ask", asked: true });
	// The work's number does not matter, and a cancellation below the line is asked about, not done.
	expect(
		decisionOf(
			prediction("d", { "t7.cancel": 0.55, "conversation.respond": 0.45 }),
			THRESHOLDS,
		),
	).toMatchObject({ row: 6, id: "work.cancel", asked: true });
});

test("the measures: top-1, recall, decisions, false dispatch, misses, asks, per-id recall, latency and rows", () => {
	const items = [
		item("i1", "music.create"),
		item("i2", "music.create", {
			gold: { primary: "music.create", acceptable: ["music.library"] },
		}),
		item("i3", "conversation.respond"),
		item("i4", "conversation.respond"),
		item("i5", "ask"),
		item("i6", "work.check"),
		item("i7", "work.cancel"),
		item("i8", "music.create"),
	];
	const predictions = [
		prediction("i1", { "music.create": 0.8, "conversation.respond": 0.2 }),
		prediction(
			"i2",
			{
				"music.library": 0.7,
				"music.create": 0.2,
				"conversation.respond": 0.1,
			},
			{ durationMs: 200 },
		),
		prediction(
			"i3",
			{ "conversation.respond": 0.9, "music.create": 0.1 },
			{ durationMs: 300 },
		),
		prediction(
			"i4",
			{ "music.create": 0.8, "conversation.respond": 0.2 },
			{ durationMs: 400 },
		),
		prediction(
			"i5",
			{
				"music.create": 0.29,
				"music.library": 0.28,
				"conversation.respond": 0.22,
				"memory.request": 0.21,
			},
			{ durationMs: 500 },
		),
		prediction(
			"i6",
			{ "conversation.respond": 0.7, "t2.check": 0.3 },
			{ durationMs: 600 },
		),
		// Below the adoption line a cancellation is asked about once more: it decides nothing yet.
		prediction(
			"i7",
			{ "t7.cancel": 0.55, "conversation.respond": 0.45 },
			{ durationMs: 700 },
		),
		// A question back whose first choice was the gold: needless.
		prediction(
			"i8",
			{
				"music.create": 0.29,
				"music.library": 0.28,
				"conversation.respond": 0.22,
				"memory.request": 0.21,
			},
			{ durationMs: 800 },
		),
	];
	const summary = score({
		items,
		predictions,
		split: "test",
		thresholds: THRESHOLDS,
	});
	expect(summary.n).toBe(8);
	// Argmax is right for i1, i2 (acceptable), i3, i7 and i8; i4 chose music over the conversation; i5 and i6 are wrong.
	expect(summary.top1).toBeCloseTo(5 / 8);
	// All but i5 have their gold in the top 3; `ask` is never a candidate.
	expect(summary.recallAt3).toBeCloseTo(7 / 8);
	// Decisions: i1, i2, i3 right; i5 asked (right: gold is ask); i4, i6, i8 wrong; i7's question once more counts for nothing.
	expect(summary.reAsks).toBe(1);
	expect(summary.decisionAccuracy).toBeCloseTo(4 / 7);
	expect(summary.falseDispatchRate).toEqual({ rate: 0.5, of: 2 });
	expect(summary.missRate).toEqual({ rate: 1 / 6, of: 6 });
	// The asks of row 8 and the host's second asks of rows 5 and 6 are apart; i8's question was needless (its top-1 was right).
	expect(summary.askRate).toBeCloseTo(2 / 8);
	expect(summary.reconfirmRate).toBeCloseTo(1 / 8);
	expect(summary.needlessAskRate).toEqual({ rate: 0.5, of: 2 });
	expect(summary.latencyMs).toEqual({ n: 8, p50: 400, p95: 800 });
	expect(summary.rows).toEqual({ row2: 3, row1: 2, row8: 2, row6: 1 });
	expect(summary.perGoldRecall.minimum).toMatchObject({ recall: 0 });
});

test("only reviewed items of the split count; null splits count under `any` only", () => {
	const items = [
		item("a", "music.create"),
		item("b", "music.create", { review: { status: "pending" } }),
		item("c", "music.create", { review: null }),
		item("d", "music.create", { split: "calibration" }),
		item("e", "music.create", { split: null }),
	];
	const predictions = items.map((i) =>
		prediction(i.id, { "music.create": 0.9, "conversation.respond": 0.1 }),
	);
	const of = (split: string) =>
		score({ items, predictions, split, thresholds: THRESHOLDS });
	expect(of("test")).toMatchObject({
		n: 1,
		itemsInSplit: 3,
		skippedUnreviewed: 2,
		unusedPredictions: 4,
	});
	expect(of("calibration").n).toBe(1);
	expect(of("any")).toMatchObject({ n: 3, itemsInSplit: 5 });
});

test("an item with no prediction stops the run and is named; an unreviewed one needs none", () => {
	const items = [
		item("a", "x"),
		item("b", "x"),
		item("c", "x", { review: null }),
	];
	try {
		score({
			items,
			predictions: [prediction("a", { x: 1 })],
			split: "test",
			thresholds: THRESHOLDS,
		});
		throw new Error("not reached");
	} catch (error) {
		expect(error).toBeInstanceOf(MissingPredictions);
		expect((error as MissingPredictions).ids).toEqual(["b"]);
	}
});

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function workspace() {
	const dir = mkdtempSync(join(tmpdir(), "router-bench-"));
	dirs.push(dir);
	const jsonl = (name: string, rows: unknown[]) => {
		writeFileSync(
			join(dir, name),
			`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);
		return join(dir, name);
	};
	return { dir, jsonl };
}

test("the command writes summary.json and a Japanese report.md into a new directory, and refuses one that exists", () => {
	const { dir, jsonl } = workspace();
	const items = jsonl("items.jsonl", [
		{
			id: "m1",
			split: "test",
			gold: { primary: "music.create", acceptable: [] },
			review: { status: "reviewed" },
		},
	]);
	const predictions = jsonl("predictions.jsonl", [
		{
			id: "m1",
			probabilities: { "music.create": 0.8, "conversation.respond": 0.2 },
			durationMs: 120,
			revision: "r1",
		},
	]);
	const out = join(dir, "out");
	main(["--items", items, "--predictions", predictions, "--out", out]);
	const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
	expect(summary).toMatchObject({ n: 1, top1: 1, decisionAccuracy: 1 });
	const report = readFileSync(join(out, "report.md"), "utf8");
	expect(report).toContain("# Router 採点結果");
	expect(report).toContain("Top-1（argmax） | 100.0%");
	expect(() =>
		main(["--items", items, "--predictions", predictions, "--out", out]),
	).toThrow("out_exists");
	// A threshold file moves the decision: with accept above the top probability the row is no longer 2.
	const settings = join(dir, "settings.json");
	writeFileSync(settings, JSON.stringify({ accept: 0.9, approve: 0.95 }));
	const again = join(dir, "again");
	main([
		"--items",
		items,
		"--predictions",
		predictions,
		"--settings",
		settings,
		"--out",
		again,
	]);
	expect(
		JSON.parse(readFileSync(join(again, "summary.json"), "utf8")).rows,
	).toEqual({
		row3: 1,
	});
	// A missing prediction writes nothing.
	const lone = jsonl("lone.jsonl", []);
	const none = join(dir, "none");
	expect(() =>
		main(["--items", items, "--predictions", lone, "--out", none]),
	).toThrow(MissingPredictions);
	expect(existsSync(none)).toBe(false);
});
