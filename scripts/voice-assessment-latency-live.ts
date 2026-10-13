import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createLiveLarm, liveLarmSettings } from "./live-larm";
import { voiceAssessmentCases } from "./voice-assessment-cases";
import { configureLogging, withLogContext } from "../api/infrastructure/logger";
import { parseLlmJson } from "../api/infrastructure/llm-json";
import {
	transcriptLanguageMessages,
	transcriptAssessmentResult,
	parseTranscriptAssessment,
	transcriptLanguageStatus,
} from "../api/domains/voice-dialogue/service/transcript-language";

const out = resolve("spec/verification/voice-input-latency-2026-10-14");
const hash = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const messagesFor = (c: (typeof voiceAssessmentCases)[number]) =>
	transcriptLanguageMessages(c.text, {
		previousText: c.previousText,
		conversation: c.conversation,
	});
const baselinePath = join(out, "baseline-messages.json");
mkdirSync(out, { recursive: true });
if (process.argv.includes("--capture-baseline")) {
	writeFileSync(
		baselinePath,
		JSON.stringify(
			voiceAssessmentCases.map((c) => ({ id: c.id, messages: messagesFor(c) })),
			null,
			2,
		),
		{ flag: "wx" },
	);
	process.exit(0);
}
if (!process.argv.includes("--run"))
	throw new Error("use --run for live comparison");
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Array<{
	id: string;
	messages: ReturnType<typeof messagesFor>;
}>;
const baselineOnly = process.argv.includes("--baseline-only");
const name = baselineOnly ? "baseline-smoke" : "final-comparison";
configureLogging({
	file: join(out, `${name}.jsonl`),
	destination: { write() {} },
});
const samples: Array<Record<string, unknown>> = [];
const settingsHash = hash(liveLarmSettings());
const options = {
	maxOutputTokens: 512,
	jsonOutput: true,
	contextPolicy: "exact",
	sessionRole: "main",
} as const;
const snapshot = voiceAssessmentCases.map((c) => ({
	id: c.id,
	messages: messagesFor(c),
}));
for (const c of snapshot) {
	const original = baseline.find((b) => b.id === c.id);
	if (!original || original.messages[1]?.content !== c.messages[1]?.content)
		throw new Error("benchmark_input_mismatch");
}
if (!baselineOnly && hash(baseline) === hash(snapshot))
	throw new Error("candidate_identical_to_baseline");
if (!baselineOnly)
	writeFileSync(
		join(out, "final-candidate-messages.json"),
		JSON.stringify(snapshot, null, 2),
	);
let consecutiveFailures = 0;
const stopped = new AbortController();
const stop = () => stopped.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
comparison: for (
	let repetition = 0;
	repetition < (baselineOnly ? 1 : 2);
	repetition++
) {
	for (const [index, c] of (baselineOnly
		? voiceAssessmentCases.slice(0, 1)
		: voiceAssessmentCases
	).entries()) {
		const variants = baselineOnly
			? ["before"]
			: (index + repetition) % 2
				? ["after", "before"]
				: ["before", "after"];
		for (const variant of variants) {
			const messages = (variant === "before" ? baseline : snapshot).find(
				(v) => v.id === c.id,
			)!.messages;
			const sampleId = crypto.randomUUID();
			if (hash(liveLarmSettings()) !== settingsHash)
				throw new Error("saved_settings_changed");
			await withLogContext(
				{ subjectId: sampleId, purpose: "llm" },
				async () => {
					// Each sample is the same short-lived connection used inside the auxiliary adapter.
					const port = createLiveLarm();
					const started = performance.now();
					let model: string | undefined;
					let phase = "inference";
					try {
						const raw = await port.answer(
							messages,
							AbortSignal.any([AbortSignal.timeout(8000), stopped.signal]),
							{
								...options,
								onExchange: async (e) => {
									model = e.model;
								},
							},
						);
						const durationMs = performance.now() - started;
						phase = "parse";
						const a =
							variant === "before"
								? transcriptAssessmentResult.parse(parseLlmJson(raw, 4096))
								: parseTranscriptAssessment(raw);
						const languageStatus = transcriptLanguageStatus(a, ["ja"]);
						const pass =
							a.status ===
								(c.languages.length ? "identified" : "undetermined") &&
							[...a.languages].sort().join() ===
								[...c.languages].sort().join() &&
							(!c.languages.length || a.confidence >= 0.8) &&
							a.relation === c.relation &&
							a.relationConfidence >= 0.8 &&
							a.readiness === c.readiness &&
							(c.readiness === "uncertain" || a.readinessConfidence >= 0.8);
						samples.push({
							sampleId,
							id: c.id,
							variant,
							repetition,
							model,
							durationMs,
							messageHash: hash(messages),
							requestBytes: Buffer.byteLength(JSON.stringify(messages)),
							responseBytes: Buffer.byteLength(raw),
							assessment: a,
							languageStatus,
							pass,
						});
					} catch {
						samples.push({
							sampleId,
							id: c.id,
							variant,
							repetition,
							model,
							durationMs: performance.now() - started,
							pass: false,
							error:
								phase === "parse" ? "invalid_assessment" : "control_failed",
						});
					}
					await port.close();
					consecutiveFailures =
						samples.at(-1)?.error === "control_failed"
							? consecutiveFailures + 1
							: 0;
					console.log(JSON.stringify(samples.at(-1)));
					writeFileSync(
						join(out, `${name}.json`),
						JSON.stringify(
							{
								lane: "live_control_adapter_synthetic_inputs",
								at: new Date().toISOString(),
								options,
								timeoutMs: 8000,
								baselineHash: hash(baseline),
								candidateHash: hash(snapshot),
								samples,
							},
							null,
							2,
						),
					);
				},
			);
			if (consecutiveFailures >= 3 || stopped.signal.aborted) break comparison;
		}
	}
}
if (samples.some((s) => !s.pass)) process.exitCode = 1;
process.removeListener("SIGINT", stop);
process.removeListener("SIGTERM", stop);
if (stopped.signal.aborted) process.exitCode = 130;
