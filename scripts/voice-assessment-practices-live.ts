import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createLiveLarm, liveLarmSettings } from "./live-larm";
import { voiceAssessmentCases } from "./voice-assessment-cases";
import {
	assessmentRequest,
	scoreAssessment,
	variants,
	type Variant,
} from "./voice-assessment-practices";
import { configureLogging, withLogContext } from "../api/infrastructure/logger";
import { parseTranscriptAssessment } from "../api/domains/voice-dialogue/service/transcript-language";

if (!process.argv.includes("--run"))
	throw new Error("use --run for live experiments");
const arg = (name: string) =>
	process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const name = arg("name") ?? "screening";
if (!/^[a-z0-9-]+$/.test(name)) throw new Error("invalid_run_name");
const selected = (
	arg("variants") ?? "baseline,schema,examples,budget128"
).split(",");
if (
	selected.some((v) => !variants.includes(v as Variant)) ||
	new Set(selected).size !== selected.length
)
	throw new Error("invalid_variants");
const reps = Number(arg("reps") ?? 1);
if (!Number.isInteger(reps) || reps < 1 || reps > 3)
	throw new Error("invalid_repetitions");
const out = resolve("spec/verification/voice-input-practices-2026-10-14", name);
const limit = Number(arg("limit") ?? voiceAssessmentCases.length);
if (
	!Number.isInteger(limit) ||
	limit < 1 ||
	limit > voiceAssessmentCases.length
)
	throw new Error("invalid_case_limit");
const cases = voiceAssessmentCases.slice(0, limit);
mkdirSync(out, { recursive: true });
const hash = (v: unknown) =>
	createHash("sha256").update(JSON.stringify(v)).digest("hex");
// Freeze every request before running, and refuse to overwrite an earlier run.
const snapshot = cases.map((c) => ({
	id: c.id,
	requests: Object.fromEntries(
		selected.map((v) => [v, assessmentRequest(c, v as Variant)]),
	),
}));
writeFileSync(join(out, "requests.json"), JSON.stringify(snapshot, null, 2), {
	flag: "wx",
});
configureLogging({
	file: join(out, "timings.jsonl"),
	destination: { write() {} },
});
const stopped = new AbortController();
const stop = () => stopped.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const settingsHash = hash(liveLarmSettings());
const samples: Array<Record<string, unknown>> = [];
let expectedModel: string | undefined;
let failures = 0;
let stopReason = "running";
const startedAt = new Date().toISOString();
const save = () =>
	writeFileSync(
		join(out, "results.json"),
		JSON.stringify(
			{
				lane: "live_control_adapter_synthetic_inputs",
				startedAt,
				updatedAt: new Date().toISOString(),
				timeoutMs: 8000,
				repetitions: reps,
				selected,
				requestHash: hash(snapshot),
				stopReason,
				samples,
			},
			null,
			2,
		),
	);
try {
	comparison: for (let repetition = 0; repetition < reps; repetition++) {
		for (const [index, c] of cases.entries()) {
			// Rotate treatment positions and reverse alternate blocks to limit order bias.
			const offset = (index + repetition) % selected.length;
			let order = [...selected.slice(offset), ...selected.slice(0, offset)];
			if ((Math.floor(index / selected.length) + repetition) % 2)
				order = order.reverse();
			for (const variant of order) {
				if (hash(liveLarmSettings()) !== settingsHash) {
					stopReason = "settings_changed";
					break comparison;
				}
				const request = snapshot[index]!.requests[variant]!;
				const sampleId = crypto.randomUUID();
				await withLogContext(
					{ subjectId: sampleId, purpose: "llm" },
					async () => {
						const port = createLiveLarm();
						const started = performance.now();
						let firstDeltaMs: number | undefined;
						let model: string | undefined;
						let phase = "inference";
						let sample: Record<string, unknown>;
						try {
							const signal = AbortSignal.any([
								AbortSignal.timeout(8000),
								stopped.signal,
							]);
							const options = {
								...request.options,
								onExchange: async (e: { model: string }) => {
									model = e.model;
									expectedModel ??= model;
									if (model !== expectedModel)
										throw new Error("benchmark_model_changed");
								},
							};
							const raw = request.stream
								? await port.answerStream!(
										request.messages,
										signal,
										(text) => {
											if (text) firstDeltaMs ??= performance.now() - started;
										},
										options,
									)
								: await port.answer(request.messages, signal, options);
							const durationMs = performance.now() - started;
							phase = "parse";
							const assessment = parseTranscriptAssessment(raw);
							sample = {
								sampleId,
								id: c.id,
								repetition,
								variant,
								model,
								durationMs,
								firstDeltaMs,
								responseBytes: Buffer.byteLength(raw),
								assessment,
								...scoreAssessment(c, assessment),
							};
						} catch {
							sample = {
								sampleId,
								id: c.id,
								repetition,
								variant,
								model,
								durationMs: performance.now() - started,
								firstDeltaMs,
								pass: false,
								error:
									phase === "parse" ? "invalid_assessment" : "control_failed",
							};
						} finally {
							await port.close();
						}
						samples.push(sample);
						failures = sample.error === "control_failed" ? failures + 1 : 0;
						if (model && model !== expectedModel) stopReason = "model_changed";
						console.log(
							JSON.stringify({
								id: c.id,
								variant,
								repetition,
								durationMs: sample.durationMs,
								pass: sample.pass,
								falseAccept: sample.falseAccept,
								error: sample.error,
							}),
						);
						save();
					},
				);
				if (stopped.signal.aborted) {
					stopReason = "interrupted";
					break comparison;
				}
				if (failures >= 3) {
					stopReason = "three_control_failures";
					break comparison;
				}
				if (stopReason === "model_changed") break comparison;
			}
		}
	}
	if (stopReason === "running") stopReason = "completed";
} catch {
	stopReason = "runner_failed";
} finally {
	save();
	process.removeListener("SIGINT", stop);
	process.removeListener("SIGTERM", stop);
}
if (stopReason !== "completed" || samples.some((s) => !s.pass))
	process.exitCode = stopped.signal.aborted ? 130 : 1;
