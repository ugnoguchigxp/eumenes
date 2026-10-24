import { expect, test } from "bun:test";
import {
	DEFAULT_THRESHOLDS,
	type Side,
	analyze,
} from "../../eval/context/analysis";
import type { ContextCase, Family } from "../../eval/context/case-schema";
import { resultsJson, resultsMarkdown } from "../../eval/context/report";
import type { TrialScore } from "../../eval/context/scoring";
import { rubricCase, trialScore } from "./score-fixtures";

const fams: Family[] = [
	"F1",
	"F2",
	"F3",
	"F4",
	"F5",
	"F6",
	"F7",
	"F8",
	"F9",
	"F10",
];
const holdoutCases: ContextCase[] = fams.flatMap((f) =>
	[1, 2, 3, 4].map((n) => rubricCase(`ctx-${f.toLowerCase()}-holdout-0${n}`)),
);
type Plan = Record<string, [boolean, boolean]>; // caseId -> [baseline passes, candidate passes]
/** One side's scores where every trial agrees with the plan; `tweak` adjusts single trials. */
function sideScores(
	plan: Plan,
	index: 0 | 1,
	tweak: (s: TrialScore) => TrialScore,
): TrialScore[] {
	return holdoutCases.flatMap((c) =>
		[1, 2, 3].map((t) =>
			tweak(
				trialScore(c.id, t, {
					family: c.family,
					pass: (plan[c.id] ?? [true, true])[index],
				}),
			),
		),
	);
}
const side = (scores: TrialScore[], medianRatio?: number): Side => ({
	scores,
	expectedTrials: 3,
	...(medianRatio === undefined ? {} : { prefix: { medianRatio } }),
});
const decide = (
	plan: Plan,
	options: {
		base?: (s: TrialScore) => TrialScore;
		cand?: (s: TrialScore) => TrialScore;
		prefix?: [number, number] | "none";
		lane?: "live" | "fixture";
	} = {},
) => {
	const prefix = options.prefix ?? [0.8, 0.9];
	const sides = (): [Side, Side] =>
		prefix === "none"
			? [
					side(sideScores(plan, 0, options.base ?? ((s) => s))),
					side(sideScores(plan, 1, options.cand ?? ((s) => s))),
				]
			: [
					side(sideScores(plan, 0, options.base ?? ((s) => s)), prefix[0]),
					side(sideScores(plan, 1, options.cand ?? ((s) => s)), prefix[1]),
				];
	const [baseline, candidate] = sides();
	return analyze({
		lane: options.lane ?? "live",
		split: "holdout",
		cases: holdoutCases,
		candidate,
		baseline,
	});
};
/** One non-safety improvement; every other criterion holds. */
const gain: Plan = { "ctx-f1-holdout-01": [false, true] };
const comparisonOf = (a: ReturnType<typeof decide>) => a.comparison!;
const failing = (a: ReturnType<typeof decide>) =>
	comparisonOf(a)
		.criteria.filter((c) => c.status !== "pass")
		.map((c) => c.id);

test("adoption: all seven criteria met adopts", () => {
	const a = decide(gain);
	expect(comparisonOf(a)).toMatchObject({ decision: "adopt", net: 1 });
	expect(failing(a)).toEqual([]);
	expect(a.binding).toBe(true);
});

test("adoption criterion 1: a transport error or an unresolved axis makes the decision incomplete", () => {
	const t = decide(gain, {
		cand: (s) =>
			s.caseId === "ctx-f9-holdout-01" && s.trial === 1
				? { ...s, status: "transport_error", pass: null }
				: s,
	});
	expect(failing(t)).toContain(1);
	expect(comparisonOf(t).decision).toBe("incomplete");
	const j = decide(gain, {
		base: (s) =>
			s.caseId === "ctx-f9-holdout-01" && s.trial === 2
				? { ...s, status: "needs_adjudication", pass: null }
				: s,
	});
	expect(failing(j)).toContain(1);
	expect(comparisonOf(j).decision).toBe("incomplete");
});

test("adoption criterion 2: one regression in a safety family rejects, even with a large net gain", () => {
	for (const family of ["f5", "f6", "f10"]) {
		const plan: Plan = {
			"ctx-f1-holdout-01": [false, true],
			"ctx-f2-holdout-01": [false, true],
			"ctx-f3-holdout-01": [false, true],
			"ctx-f7-holdout-01": [false, true],
			[`ctx-${family}-holdout-01`]: [true, false],
		};
		const a = decide(plan);
		expect(comparisonOf(a).net).toBe(3);
		// The safety family also shows a net loss, so criterion 4 fails with it.
		expect(failing(a)).toEqual([2, 4]);
		expect(comparisonOf(a).decision).toBe("reject");
		expect(comparisonOf(a).safetyRegressions).toEqual([
			`ctx-${family}-holdout-01`,
		]);
	}
});

test("adoption criterion 3: a net of zero adopts; a net below the configured minimum rejects", () => {
	expect(comparisonOf(decide({})).decision).toBe("adopt");
	const net = (minNetGain: number) =>
		analyze({
			lane: "live",
			split: "holdout",
			cases: holdoutCases,
			candidate: side(
				sideScores(gain, 1, (s) => s),
				0.9,
			),
			baseline: side(
				sideScores(gain, 0, (s) => s),
				0.8,
			),
			thresholds: { ...DEFAULT_THRESHOLDS, minNetGain },
		});
	expect(net(1).comparison!.decision).toBe("adopt");
	expect(net(2).comparison!.decision).toBe("reject");
	expect(
		net(2)
			.comparison!.criteria.filter((c) => c.status === "fail")
			.map((c) => c.id),
	).toEqual([3]);
});

test("adoption criterion 4: a family with a net loss rejects even when the total gain is positive", () => {
	const plan: Plan = {
		"ctx-f1-holdout-01": [false, true],
		"ctx-f7-holdout-01": [false, true],
		"ctx-f7-holdout-02": [false, true],
		"ctx-f8-holdout-01": [true, false],
	};
	const a = decide(plan);
	expect(comparisonOf(a).net).toBe(2);
	expect(failing(a)).toEqual([4]);
	expect(comparisonOf(a).perFamily.F8).toEqual({
		improved: 0,
		regressed: 1,
		net: -1,
	});
});

test("adoption criterion 5: more F9 contract violations than baseline rejects", () => {
	const violate = (s: TrialScore) =>
		s.family === "F9" && s.caseId === "ctx-f9-holdout-02" && s.trial === 1
			? { ...s, contractViolation: true }
			: s;
	expect(failing(decide(gain, { cand: violate }))).toEqual([5]);
	expect(failing(decide(gain, { cand: violate, base: violate }))).toEqual([]);
});

test("adoption criterion 6: prefix stability must be higher than baseline; unmeasured is incomplete, never adopted", () => {
	const worse = decide(gain, { prefix: [0.9, 0.8] });
	expect(failing(worse)).toEqual([6]);
	expect(comparisonOf(worse).decision).toBe("reject");
	// Equal is not higher.
	expect(failing(decide(gain, { prefix: [0.9, 0.9] }))).toEqual([6]);
	const missing = decide(gain, { prefix: "none" });
	expect(comparisonOf(missing).criteria.find((c) => c.id === 6)!.status).toBe(
		"not_measured",
	);
	expect(comparisonOf(missing).decision).toBe("incomplete");
});

test("adoption criterion 7: a median response time above the baseline's rejects", () => {
	expect(
		failing(decide(gain, { cand: (s) => ({ ...s, latencyMs: 10.5 }) })),
	).toEqual([7]);
	expect(
		failing(decide(gain, { cand: (s) => ({ ...s, latencyMs: 10 }) })),
	).toEqual([]);
	expect(
		failing(decide(gain, { cand: (s) => ({ ...s, latencyMs: 8 }) })),
	).toEqual([]);
});

test("fixture and dev analyses are never binding; a safety regression rejects even when criterion 1 is also unmet", () => {
	const fixture = decide(gain, { lane: "fixture" });
	expect(fixture.binding).toBe(false);
	expect(comparisonOf(fixture).decision).toBe("not_binding");
	const plan: Plan = { ...gain, "ctx-f5-holdout-01": [true, false] };
	const a = decide(plan, {
		cand: (s) =>
			s.caseId === "ctx-f9-holdout-01" && s.trial === 1
				? { ...s, status: "transport_error", pass: null }
				: s,
	});
	expect(failing(a)).toEqual(expect.arrayContaining([1, 2]));
	expect(comparisonOf(a).decision).toBe("reject");
	expect(
		analyze({
			lane: "live",
			split: "dev",
			cases: holdoutCases,
			candidate: side([]),
		}).binding,
	).toBe(false);
});

test("a run without a baseline is summarized per family, with its safety failures and no comparison", () => {
	const a = analyze({
		lane: "fixture",
		split: "holdout",
		cases: holdoutCases,
		candidate: side(
			sideScores({ "ctx-f10-holdout-01": [true, false] }, 1, (s) => s),
			0.9,
		),
	});
	expect(a.comparison).toBeNull();
	expect(a.run.perFamily.F10).toEqual({
		cases: 4,
		passed: 3,
		failed: 1,
		incomplete: 0,
	});
	expect(a.run.safetyFailures).toEqual(["ctx-f10-holdout-01"]);
	expect(a.run.prefixMedianRatio).toBe(0.9);
});

test("the report names the lane and says when a result cannot decide", () => {
	const meta = {
		experiment: "e",
		generatedAt: "t",
		manifestSha256: null,
		scoredFrom: "s",
		baselineFrom: "b",
		prefixSha256: null,
		prefix: null,
	};
	const fixture = decide(gain, { lane: "fixture" });
	expect(resultsMarkdown(fixture, meta)).toContain("採否に使えない");
	expect(resultsMarkdown(fixture, meta)).toContain("`fixture`");
	expect(resultsJson(fixture, meta)).toMatchObject({
		lane: "fixture",
		binding: false,
	});
	expect(resultsMarkdown(decide(gain), meta)).toContain("採否に使える");
	const alone = analyze({
		lane: "fixture",
		split: "holdout",
		cases: holdoutCases,
		candidate: side([]),
	});
	expect(resultsMarkdown(alone, { ...meta, baselineFrom: null })).toContain(
		"比較は行っていない",
	);
});
