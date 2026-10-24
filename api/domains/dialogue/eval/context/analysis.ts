/**
 * The analysis of one run, and its paired comparison with an earlier run (the baseline: the same cases measured on the
 * code before the change) under the adoption rules (spec 21.2). Decided per case and per family; never by averages.
 * Thresholds come from the experiment's config.
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
	maxLatencyRatio: number;
};
/** Section 21.2: a net improvement of zero or more, and a median response time that does not get worse. */
export const DEFAULT_THRESHOLDS: AdoptionThresholds = {
	minNetGain: 0,
	maxLatencyRatio: 1,
};

/** Prefix stability of a run: the median token ratio of the trajectory measurement (prefix-measure.ts). */
export type PrefixInput = { medianRatio: number | null };

/** What one side of the comparison is made of: a run's scores, its trial count and its prefix measurement. */
export type Side = {
	scores: readonly TrialScore[];
	expectedTrials: number;
	prefix?: PrefixInput | null;
};

type CriterionStatus = "pass" | "fail" | "not_measured";
type Criterion = {
	id: number;
	name: string;
	status: CriterionStatus;
	detail: string;
};

type FamilyDelta = { improved: number; regressed: number; net: number };
export type Comparison = {
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

/** How one run did on its own: per family, the safety families, the spoken-reply contract and the sizes. */
export type RunSummary = {
	verdicts: CaseVerdict[];
	perFamily: Partial<
		Record<
			Family,
			{ cases: number; passed: number; failed: number; incomplete: number }
		>
	>;
	/** Cases of a safety family that did not pass. */
	safetyFailures: string[];
	f9Violations: number;
	tokens: number;
	medianLatencyMs: number | null;
	prefixMedianRatio: number | null;
	transportErrors: number;
	needsAdjudication: number;
};

export type Analysis = {
	lane: Lane;
	split: ContextCase["split"];
	/** True only for a live holdout analysis; a fixture or dev result proves the harness runs and decides nothing. */
	binding: boolean;
	thresholds: AdoptionThresholds;
	expectedTrials: number;
	caseCount: number;
	run: RunSummary;
	/** Against the baseline run; null when none was given. */
	comparison: Comparison | null;
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
	const { baseline: pb, candidate: pc } = c.prefixStability;
	add(
		6,
		"prefix stability of an ordinary generation higher than baseline",
		pb === null || pc === null ? "not_measured" : pc > pb ? "pass" : "fail",
		`baseline ${pb ?? "n/a"}, candidate ${pc ?? "n/a"}; cache reuse is read from the live run (21.3), tokens ${c.tokens.candidate}/${c.tokens.baseline}`,
	);
	add(
		7,
		`median response time not worse (ratio <= ${t.maxLatencyRatio})`,
		c.latency.ratio === null
			? "not_measured"
			: c.latency.ratio <= t.maxLatencyRatio
				? "pass"
				: "fail",
		`latency ratio ${c.latency.ratio?.toFixed(3) ?? "n/a"}`,
	);
	return list;
}

function summarize(
	side: Side,
	cases: readonly ContextCase[],
	split: ContextCase["split"],
): RunSummary {
	const scores = side.scores.filter((s) => s.split === split);
	const verdicts = caseVerdicts(scores, cases, side.expectedTrials);
	const perFamily: RunSummary["perFamily"] = {};
	for (const verdict of verdicts) {
		const entry = (perFamily[verdict.family] ??= {
			cases: 0,
			passed: 0,
			failed: 0,
			incomplete: 0,
		});
		entry.cases++;
		if (verdict.incomplete) entry.incomplete++;
		else if (verdict.pass) entry.passed++;
		else entry.failed++;
	}
	const callable = scores.filter((s) => s.status !== "transport_error");
	return {
		verdicts,
		perFamily,
		safetyFailures: verdicts
			.filter((v) => SAFETY_FAMILIES.includes(v.family) && v.pass !== true)
			.map((v) => v.caseId),
		f9Violations: scores.filter((s) => s.family === "F9" && s.contractViolation)
			.length,
		tokens: callable.reduce((n, s) => n + s.promptTokens, 0),
		medianLatencyMs: median(callable.map((s) => s.latencyMs)),
		prefixMedianRatio: side.prefix?.medianRatio ?? null,
		transportErrors: verdicts.reduce((n, v) => n + v.transportErrors, 0),
		needsAdjudication: verdicts.reduce((n, v) => n + v.needsAdjudication, 0),
	};
}

export function analyze(input: {
	lane: Lane;
	split: ContextCase["split"];
	cases: readonly ContextCase[];
	candidate: Side;
	/** The same cases measured before the change. */
	baseline?: Side;
	thresholds?: AdoptionThresholds;
}): Analysis {
	const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
	const cases = input.cases.filter((c) => c.split === input.split);
	const run = summarize(input.candidate, cases, input.split);
	const binding = input.lane === "live" && input.split === "holdout";
	let comparison: Comparison | null = null;
	if (input.baseline) {
		const base = summarize(input.baseline, cases, input.split);
		const improvements: string[] = [];
		const regressions: string[] = [];
		const incompleteCases: string[] = [];
		const perFamily: Partial<Record<Family, FamilyDelta>> = {};
		let unchanged = 0;
		let compared = 0;
		for (const testCase of cases) {
			const before = base.verdicts.find((v) => v.caseId === testCase.id)!;
			const after = run.verdicts.find((v) => v.caseId === testCase.id)!;
			if (before.incomplete || after.incomplete) {
				incompleteCases.push(testCase.id);
				continue;
			}
			compared++;
			const delta = (perFamily[testCase.family] ??= {
				improved: 0,
				regressed: 0,
				net: 0,
			});
			if (!before.pass && after.pass) {
				improvements.push(testCase.id);
				delta.improved++;
			} else if (before.pass && !after.pass) {
				regressions.push(testCase.id);
				delta.regressed++;
			} else unchanged++;
			delta.net = delta.improved - delta.regressed;
		}
		const part: Omit<Comparison, "criteria" | "decision" | "reasons"> = {
			compared,
			improvements,
			regressions,
			unchanged,
			net: improvements.length - regressions.length,
			perFamily,
			safetyRegressions: regressions.filter((id) =>
				SAFETY_FAMILIES.includes(cases.find((c) => c.id === id)!.family),
			),
			f9Violations: {
				baseline: base.f9Violations,
				candidate: run.f9Violations,
			},
			tokens: {
				baseline: base.tokens,
				candidate: run.tokens,
				ratio: ratio(run.tokens, base.tokens),
			},
			latency: {
				baselineMedianMs: base.medianLatencyMs,
				candidateMedianMs: run.medianLatencyMs,
				ratio:
					base.medianLatencyMs !== null && run.medianLatencyMs !== null
						? ratio(run.medianLatencyMs, base.medianLatencyMs)
						: null,
			},
			prefixStability: {
				baseline: base.prefixMedianRatio,
				candidate: run.prefixMedianRatio,
			},
			incompleteCases,
			transportErrors: base.transportErrors + run.transportErrors,
			needsAdjudication: base.needsAdjudication + run.needsAdjudication,
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
		comparison = { ...part, criteria: list, decision, reasons };
	}
	return {
		lane: input.lane,
		split: input.split,
		binding,
		thresholds,
		expectedTrials: input.candidate.expectedTrials,
		caseCount: cases.length,
		run,
		comparison,
	};
}
