import { readFileSync } from "node:fs";
import { flushLogging } from "../../api/infrastructure/logger";

type Event = Record<string, unknown>;
export type MeasuredCall = {
	subjectId: string;
	calls?: number;
	outcome: unknown;
};

export function latencyStats(values: readonly number[]) {
	const times = [...values].sort((a, b) => a - b);
	const n = times.length,
		middle = Math.floor(n / 2);
	return {
		medianMs: !n
			? null
			: n % 2
				? times[middle]!
				: (times[middle - 1]! + times[middle]!) / 2,
		p95Ms: times[Math.ceil(n * 0.95) - 1] ?? null,
		maxMs: times.at(-1) ?? null,
	};
}

/** Readers must see the final buffered timing before deriving acceptance. */
export function readEvents(file: string): Event[] {
	flushLogging();
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

export function callReport<T extends MeasuredCall>(events: Event[], rows: T[]) {
	const metrics = events.filter((e) =>
		[
			"larm.llm_timing",
			"larm.token_count_completed",
			"larm.token_count_failed",
			"performance.stage",
		].includes(String(e.event)),
	);
	const issues: Array<{ subjectId: string; reason: string }> = [];
	const seen = new Set<string>();
	const measured = rows.map((row) => {
		if (seen.has(row.subjectId))
			issues.push({ subjectId: row.subjectId, reason: "duplicate_subject" });
		seen.add(row.subjectId);
		const own = metrics.filter((e) => e.subjectId === row.subjectId);
		const counts = own.filter((e) => e.event === "larm.token_count_completed");
		const failedCounts = own.filter(
			(e) => e.event === "larm.token_count_failed",
		);
		const timings = own.filter((e) => e.event === "larm.llm_timing");
		const expected = row.calls ?? 1;
		if (counts.length + failedCounts.length !== expected)
			issues.push({ subjectId: row.subjectId, reason: "token_count_coverage" });
		if (timings.length !== expected)
			issues.push({ subjectId: row.subjectId, reason: "timing_coverage" });
		if (row.outcome === "ok" && timings.some((e) => e.outcome !== "ok"))
			issues.push({
				subjectId: row.subjectId,
				reason: "timing_outcome_mismatch",
			});
		if (
			counts.some(
				(e) =>
					typeof e.bootEpoch !== "string" ||
					!e.bootEpoch ||
					typeof e.configRevision !== "string" ||
					!e.configRevision,
			) ||
			failedCounts.length
		)
			issues.push({ subjectId: row.subjectId, reason: "revision_unavailable" });
		const count = counts.at(-1),
			timing = timings.at(-1);
		return {
			...row,
			formalTokens: count?.promptTokens,
			cacheTokens: timing?.providerCachedTokens ?? timing?.cachedTokens,
			prefillMs: timing?.providerPromptMs,
			evaluatedTokens: timing?.providerPromptTokens,
			ttftMs: timing?.ttftMs,
			finishReason: timing?.finishReason,
			streamFailure: timing?.streamFailure,
			counts: counts.length,
			timings: timings.length,
		};
	});
	for (const event of metrics) {
		if (
			event.event !== "performance.stage" &&
			(typeof event.subjectId !== "string" || !seen.has(event.subjectId))
		)
			issues.push({
				subjectId:
					typeof event.subjectId === "string"
						? event.subjectId
						: "unattributed",
				reason: "unmatched_measurement",
			});
	}
	const relevant = metrics.filter((e) =>
		rows.some((row) => row.subjectId === e.subjectId),
	);
	const counts = relevant.filter(
		(e) => e.event === "larm.token_count_completed",
	);
	const bootEpochs = [
		...new Set(
			counts.map((e) => e.bootEpoch).filter((x) => typeof x === "string"),
		),
	];
	const configRevisions = [
		...new Set(
			counts.map((e) => e.configRevision).filter((x) => typeof x === "string"),
		),
	];
	const coverageComplete = rows.length > 0 && issues.length === 0;
	return {
		rows: measured,
		metrics: relevant,
		issues,
		coverageComplete,
		bootEpochs,
		configRevisions,
		revisionComparable:
			coverageComplete &&
			bootEpochs.length === 1 &&
			configRevisions.length === 1,
	};
}

/** Size is an explicit formal-token target, never an estimate or a surrogate for visibility. */
export function cacheAcceptance(
	report: ReturnType<typeof callReport>,
	target = 14000,
	tolerance = 256,
) {
	const main = report.rows.filter(
		(r) =>
			"role" in r &&
			r.role === "main" &&
			!(
				"phase" in r &&
				typeof r.phase === "string" &&
				r.phase.startsWith("calibration_")
			),
	);
	const visible = report.rows.every(
		(r) => "correct" in r && r.correct === true && r.outcome === "ok",
	);
	const formalSize =
		main.length > 0 &&
		main.every(
			(r) =>
				typeof r.formalTokens === "number" &&
				Number.isSafeInteger(r.formalTokens) &&
				r.formalTokens >= 0 &&
				Math.abs(r.formalTokens - target) <= tolerance,
		);
	const phaseOf = (r: (typeof report.rows)[number]) =>
		"phase" in r ? r.phase : "regime" in r ? r.regime : undefined;
	const retained = ["immediate_repeat", "after_four_auxiliary"].every(
		(phase) => {
			const row = main.find((r) => phaseOf(r) === phase);
			return (
				row &&
				typeof row.cacheTokens === "number" &&
				typeof row.formalTokens === "number" &&
				Number.isSafeInteger(row.cacheTokens) &&
				row.cacheTokens <= row.formalTokens &&
				row.cacheTokens >= row.formalTokens - 8
			);
		},
	);
	const scenario = report.rows.filter((r) => {
		const phase = phaseOf(r);
		return typeof phase !== "string" || !phase.startsWith("calibration_");
	});
	const phases = [
		"first_seen",
		"immediate_repeat",
		"same_system_different_user",
		"background_updated",
		"original_repeat",
		"auxiliary_1",
		"auxiliary_2",
		"auxiliary_3",
		"auxiliary_4",
		"after_four_auxiliary",
	];
	const scenarioComplete =
		phases.length === scenario.length &&
		phases.every((phase, i) => {
			const row = scenario[i]!;
			return (
				phaseOf(row) === phase &&
				"role" in row &&
				row.role === (phase.startsWith("auxiliary_") ? "auxiliary" : "main")
			);
		});
	return {
		passed:
			visible &&
			formalSize &&
			retained &&
			scenarioComplete &&
			report.revisionComparable,
		visible,
		formalSize,
		retained,
		scenarioComplete,
		target,
		tolerance,
	};
}
