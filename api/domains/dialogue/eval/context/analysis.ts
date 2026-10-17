/**
 * Paired baseline vs candidate analysis and the adoption rules (spec 5.6).
 * Decided per case and per family; never by averages. Thresholds come from the experiment's config.
 */
import {
	type ContextCase,
	FAMILIES,
	type Family,
	SAFETY_FAMILIES,
} from "./case-schema";
import { median } from "./prefix-stability";
import type { Lane } from "./raw";
import { type CaseVerdict, type TrialScore, caseVerdicts } from "./scoring";

export type AdoptionThresholds = {
	minNetGain: number;
	maxTokenRatio: number;
	maxLatencyRatio: number;
};
export const DEFAULT_THRESHOLDS: AdoptionThresholds = {
	minNetGain: 4,
	maxTokenRatio: 1.1,
	maxLatencyRatio: 1.15,
};

/** Prefix stability per arm (see prefix-stability.ts). Filled by a later multi-turn measurement. */
export type PrefixInput = Record<string, { medianRatio: number | null }>;

export type CriterionStatus = "pass" | "fail" | "not_measured";
export type Criterion = {
	id: number;
	name: string;
	status: CriterionStatus;
	detail: string;
};

export type FamilyDelta = { improved: number; regressed: number; net: number };
export type Comparison = {
	arm: string;
	baseline: string;
	compared: number;
	improvements: string[];
	regressions: string[];
	unchanged: number;
	net: number;
	perFamily: Partial<Record<Family, FamilyDelta>>;
	safetyRegressions: string[];
	f9Violations: { baseline: number; candidate: number };
	tokens: { baseline: number; candidate: number; ratio: number | null };
	latency: {
		baselineMedianMs: number | null;
		candidateMedianMs: number | null;
		ratio: number | null;
	};
	prefixStability: { baseline: number | null; candidate: number | null };
	incompleteCases: string[];
	transportErrors: number;
	needsAdjudication: number;
	criteria: Criterion[];
	/**
	 * adopt: every criterion passes. reject: some criterion failed (a safety regression always rejects, whatever else
	 * is unmet). incomplete: nothing failed that settles it, but a criterion is unmet or could not be measured.
	 * not_binding: the analysis is not a live holdout one (fixture or dev), so no decision is made.
	 */
	decision: "adopt" | "reject" | "incomplete" | "not_binding";
	/** Every criterion that is not met, with its detail. */
	reasons: string[];
};

export type Analysis = {
	lane: Lane;
	split: ContextCase["split"];
	/** True only for a live holdout analysis; a fixture or dev result proves the harness runs and decides nothing. */
	binding: boolean;
	baseline: string;
	thresholds: AdoptionThresholds;
	expectedTrials: number;
	caseCount: number;
	verdicts: CaseVerdict[];
	comparisons: Comparison[];
};

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

function criteria(
	c: Omit<Comparison, "criteria" | "decision" | "reasons">,
	t: AdoptionThresholds,
): Criterion[] {
	const list: Criterion[] = [];
	const add = (
		id: number,
		name: string,
		status: CriterionStatus,
		detail: string,
	) => list.push({ id, name, status, detail });
	const incomplete = c.incompleteCases.length;
	add(
		1,
		"all calls complete, nothing awaiting adjudication",
		incomplete === 0 ? "pass" : "fail",
		`incomplete cases ${incomplete}, transport errors ${c.transportErrors}, needs adjudication ${c.needsAdjudication}`,
	);
	add(
		2,
		"no regression in the safety families",
		c.safetyRegressions.length === 0 ? "pass" : "fail",
		`${SAFETY_FAMILIES.join(",")} regressions ${c.safetyRegressions.length}${c.safetyRegressions.length ? `: ${c.safetyRegressions.join(",")}` : ""}`,
	);
	add(
		3,
		`net improvement >= ${t.minNetGain}`,
		c.net >= t.minNetGain ? "pass" : "fail",
		`improved ${c.improvements.length} - regressed ${c.regressions.length} = ${c.net}`,
	);
	const losing = FAMILIES.filter((f) => (c.perFamily[f]?.net ?? 0) < 0);
	add(
		4,
		"no family with a net loss",
		losing.length === 0 ? "pass" : "fail",
		losing.length ? `net loss in ${losing.join(",")}` : "none",
	);
	add(
		5,
		"F9 spoken-reply contract violations not worse than baseline",
		c.f9Violations.candidate <= c.f9Violations.baseline ? "pass" : "fail",
		`baseline ${c.f9Violations.baseline}, candidate ${c.f9Violations.candidate}`,
	);
	add(
		6,
		`token ratio <= ${t.maxTokenRatio} and median latency ratio <= ${t.maxLatencyRatio}`,
		c.tokens.ratio === null || c.latency.ratio === null
			? "not_measured"
			: c.tokens.ratio <= t.maxTokenRatio &&
				  c.latency.ratio <= t.maxLatencyRatio
				? "pass"
				: "fail",
		`token ratio ${c.tokens.ratio?.toFixed(3) ?? "n/a"}, latency ratio ${c.latency.ratio?.toFixed(3) ?? "n/a"}`,
	);
	const { baseline: pb, candidate: pc } = c.prefixStability;
	add(
		7,
		"prefix stability not below baseline",
		pb === null || pc === null ? "not_measured" : pc >= pb ? "pass" : "fail",
		`baseline ${pb ?? "n/a"}, candidate ${pc ?? "n/a"}`,
	);
	return list;
}

export function analyze(input: {
	lane: Lane;
	split: ContextCase["split"];
	baseline: string;
	candidates: readonly string[];
	cases: readonly ContextCase[];
	scores: readonly TrialScore[];
	expectedTrials: number;
	thresholds?: AdoptionThresholds;
	prefix?: PrefixInput;
}): Analysis {
	const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
	const cases = input.cases.filter((c) => c.split === input.split);
	const scores = input.scores.filter((s) => s.split === input.split);
	const arms = [input.baseline, ...input.candidates];
	const verdicts = caseVerdicts(scores, cases, arms, input.expectedTrials);
	const verdictOf = (arm: string, caseId: string) =>
		verdicts.find((v) => v.arm === arm && v.caseId === caseId)!;
	const scoresOf = (arm: string) => scores.filter((s) => s.arm === arm);
	const callable = (arm: string) =>
		scoresOf(arm).filter((s) => s.status !== "transport_error");
	const f9 = (arm: string) =>
		scoresOf(arm).filter((s) => s.family === "F9" && s.contractViolation)
			.length;
	const binding = input.lane === "live" && input.split === "holdout";
	const comparisons = input.candidates.map((arm): Comparison => {
		const improvements: string[] = [];
		const regressions: string[] = [];
		const incompleteCases: string[] = [];
		const perFamily: Partial<Record<Family, FamilyDelta>> = {};
		let unchanged = 0;
		let compared = 0;
		for (const testCase of cases) {
			const base = verdictOf(input.baseline, testCase.id);
			const cand = verdictOf(arm, testCase.id);
			if (base.incomplete || cand.incomplete) {
				incompleteCases.push(testCase.id);
				continue;
			}
			compared++;
			const delta = (perFamily[testCase.family] ??= {
				improved: 0,
				regressed: 0,
				net: 0,
			});
			if (!base.pass && cand.pass) {
				improvements.push(testCase.id);
				delta.improved++;
			} else if (base.pass && !cand.pass) {
				regressions.push(testCase.id);
				delta.regressed++;
			} else unchanged++;
			delta.net = delta.improved - delta.regressed;
		}
		const tokensOf = (name: string) =>
			callable(name).reduce((n, s) => n + s.promptTokens, 0);
		const latencyOf = (name: string) =>
			median(callable(name).map((s) => s.latencyMs));
		const base = latencyOf(input.baseline);
		const cand = latencyOf(arm);
		const part: Omit<Comparison, "criteria" | "decision" | "reasons"> = {
			arm,
			baseline: input.baseline,
			compared,
			improvements,
			regressions,
			unchanged,
			net: improvements.length - regressions.length,
			perFamily,
			safetyRegressions: regressions.filter((id) =>
				SAFETY_FAMILIES.includes(cases.find((c) => c.id === id)!.family),
			),
			f9Violations: { baseline: f9(input.baseline), candidate: f9(arm) },
			tokens: {
				baseline: tokensOf(input.baseline),
				candidate: tokensOf(arm),
				ratio: ratio(tokensOf(arm), tokensOf(input.baseline)),
			},
			latency: {
				baselineMedianMs: base,
				candidateMedianMs: cand,
				ratio: base !== null && cand !== null ? ratio(cand, base) : null,
			},
			prefixStability: {
				baseline: input.prefix?.[input.baseline]?.medianRatio ?? null,
				candidate: input.prefix?.[arm]?.medianRatio ?? null,
			},
			incompleteCases,
			transportErrors: verdicts
				.filter((v) => v.arm === arm || v.arm === input.baseline)
				.reduce((n, v) => n + v.transportErrors, 0),
			needsAdjudication: verdicts
				.filter((v) => v.arm === arm || v.arm === input.baseline)
				.reduce((n, v) => n + v.needsAdjudication, 0),
		};
		const list = criteria(part, thresholds);
		const failed = list.filter((c) => c.status === "fail").map((c) => c.id);
		const decision: Comparison["decision"] = !binding
			? "not_binding"
			: failed.includes(2)
				? "reject"
				: failed.includes(1)
					? "incomplete"
					: failed.length > 0
						? "reject"
						: list.some((c) => c.status === "not_measured")
							? "incomplete"
							: "adopt";
		const reasons = list
			.filter((c) => c.status !== "pass")
			.map((c) => `${c.id} ${c.name}: ${c.status} (${c.detail})`);
		return { ...part, criteria: list, decision, reasons };
	});
	return {
		lane: input.lane,
		split: input.split,
		binding,
		baseline: input.baseline,
		thresholds,
		expectedTrials: input.expectedTrials,
		caseCount: cases.length,
		verdicts,
		comparisons,
	};
}
