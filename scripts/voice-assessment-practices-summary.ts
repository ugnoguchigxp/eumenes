import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { voiceAssessmentCases } from "./voice-assessment-cases";

const path = resolve(
	process.argv[2] ??
		"spec/verification/voice-input-practices-2026-10-14/screening",
);
type Sample = {
	id: string;
	repetition: number;
	variant: string;
	sampleId: string;
	durationMs: number;
	firstDeltaMs?: number;
	model?: string;
	pass: boolean;
	error?: string;
	falseAccept?: boolean;
	falseReject?: boolean;
	accepted?: boolean;
	assessment?: { relation: string };
};
const run = JSON.parse(readFileSync(join(path, "results.json"), "utf8")) as {
	stopReason: string;
	selected: string[];
	samples: Sample[];
};
const logs = readFileSync(join(path, "timings.jsonl"), "utf8")
	.trim()
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line) as Record<string, unknown>);
const percentile = (values: number[], q: number) => {
	if (!values.length) return null;
	const a = [...values].sort((a, b) => a - b),
		pos = (a.length - 1) * q;
	return (
		a[Math.floor(pos)]! + (a[Math.ceil(pos)]! - a[Math.floor(pos)]!) * (pos % 1)
	);
};
const median = (v: number[]) => percentile(v, 0.5);
function pairedCI(values: number[]) {
	if (values.length < 2) return null;
	let seed = 20261014;
	const random = () => {
		seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
		return seed / 4294967296;
	};
	const means = Array.from({ length: 5000 }, () =>
		median(
			Array.from(
				{ length: values.length },
				() => values[Math.floor(random() * values.length)]!,
			),
		)!,
	);
	return [percentile(means, 0.025), percentile(means, 0.975)];
}
const summary = {
	stopReason: run.stopReason,
	models: [...new Set(run.samples.map((s) => s.model).filter(Boolean))],
	variants: run.selected.map((variant) => {
		const samples = run.samples.filter((s) => s.variant === variant),
			ok = samples.filter((s) => !s.error);
		const ids = new Set(ok.map((s) => s.sampleId));
		const llm = logs.filter(
			(l) => ids.has(String(l.subjectId)) && l.event === "larm.llm_timing",
		);
		const metric = (name: string) =>
			median(
				llm
					.map((l) => l[name])
					.filter((v): v is number => typeof v === "number"),
			);
		const stage = (name: string) =>
			median(
				logs
					.filter(
						(l) =>
							ids.has(String(l.subjectId)) &&
							l.event === "performance.stage" &&
							l.phase === name,
					)
					.map((l) => Number(l.durationMs)),
			);
		const paired =
			variant === "baseline"
				? []
				: ok.flatMap((s) => {
						const base = run.samples.find(
							(b) =>
								b.variant === "baseline" &&
								b.id === s.id &&
								b.repetition === s.repetition &&
								!b.error,
						);
						return base ? [base.durationMs - s.durationMs] : [];
					});
		return {
			variant,
			attempts: samples.length,
			responses: ok.length,
			failures: samples.filter((s) => s.error).length,
			strictPass: samples.filter((s) => s.pass).length,
			falseAccept: samples.filter((s) => s.falseAccept).map((s) => s.id),
			falseReject: samples.filter((s) => s.falseReject).map((s) => s.id),
			acceptedWrongRelation: ok
				.filter(
					(s) =>
						s.accepted &&
						s.assessment?.relation !==
							voiceAssessmentCases.find((c) => c.id === s.id)!.relation,
				)
				.map((s) => s.id),
			medianMs: median(ok.map((s) => s.durationMs)),
			p90Ms: percentile(
				ok.map((s) => s.durationMs),
				0.9,
			),
			firstDeltaMs: median(
				ok.flatMap((s) =>
					s.firstDeltaMs === undefined ? [] : [s.firstDeltaMs],
				),
			),
			firstDeltaToCompleteMs: median(
				ok.flatMap((s) =>
					s.firstDeltaMs === undefined ? [] : [s.durationMs - s.firstDeltaMs],
				),
			),
			promptTokens: metric("promptTokens"),
			completionTokens: metric("completionTokens"),
			cachedTokens: metric("cachedTokens"),
			providerReadyMs: stage("provider_ready"),
			tokenCountMs: stage("token_count"),
			providerHeadersMs: stage("response_headers"),
			providerTtftMs: metric("providerTtftMs"),
			providerPromptMs: metric("providerPromptMs"),
			providerDecodeMs: metric("providerDecodeMs"),
			providerPromptTokens: metric("providerPromptTokens"),
			providerCachedTokens: metric("providerCachedTokens"),
			providerOutputTokens: metric("providerOutputTokens"),
			pairs: paired.length,
			pairedMedianSavingMs: median(paired),
			pairedMedianBootstrap95CI: pairedCI(paired),
			fasterPairs: paired.filter((x) => x > 0).length,
		};
	}),
};
writeFileSync(join(path, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
