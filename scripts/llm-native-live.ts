import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadEvaluationCases } from "../api/application/llm-native-evaluation.fixture";
import { evaluateRequirements } from "../api/application/llm-native-runner.fixture";
import { createLiveLarm } from "./live-larm";
import { createCodexResearch } from "../api/domains/inference";
import { chooseSpeechDelivery } from "../api/domains/delivery";
import {
	transcriptLanguageMessages,
	parseTranscriptLanguage,
	transcriptLanguageStatus,
} from "../api/domains/voice-dialogue/service/transcript-language";
import { harness } from "../api/application/toolchain.fixture";
import { asrLanguages } from "../api/domains/settings/contracts";
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
	const at = args.indexOf(name);
	return at < 0 ? fallback : (args[at + 1] ?? "");
};
const suite = option("--suite", "all"),
	casesPath = resolve(
		option("--cases", "api/application/testdata/llm-native/cases.json"),
	),
	out = resolve(option("--out", "spec/verification/llm-native-2026-10-10")),
	repeats = Number(option("--repeats", "2"));
if (
	!["requirements", "delivery", "voice-language", "all"].includes(suite) ||
	!Number.isInteger(repeats) ||
	repeats !== 2
)
	throw new Error("invalid_evaluation_arguments");
const { cases, profiles } = loadEvaluationCases(casesPath);
const selected = cases.filter((c) => suite === "all" || c.suite === suite);
const ready = process.env.EUMENES_LIVE_LLM_NATIVE === "1";
const results: Array<Record<string, unknown>> = [];
casesLoop: for (const c of selected) {
	let consecutiveFailures = 0;
	for (let repeat = 1; repeat <= repeats; repeat++) {
		const start = performance.now();
		if (!ready) {
			results.push({
				caseId: c.id,
				repeat,
				status: "skipped",
				safeCode: "live_requires_explicit_flag",
				semanticChecks: "unchecked",
			});
			continue;
		}
		let cleanupPort: ReturnType<typeof createLiveLarm> | undefined;
		try {
			const port = createLiveLarm();
			cleanupPort = port;
			await port.connect();
			let result: Record<string, unknown>;
			if (c.suite === "requirements") {
				const codex =
					c.engine === "codex_luna"
						? createCodexResearch(process.env)
						: undefined;
				if (c.engine === "codex_luna" && !codex) {
					results.push({
						caseId: c.id,
						repeat,
						status: "skipped",
						safeCode: "codex_research_unavailable",
						semanticChecks: "unchecked",
					});
					continue;
				}
				const evaluated = await evaluateRequirements(c, profiles, port, codex);
				result = {
					...evaluated,
					status: evaluated.structureMatched
						? "needs_semantic_review"
						: "failed",
					lane: "live_model_fixed_artificial_sources",
				};
			} else if (c.suite === "delivery") {
				let calls = 0;
				const judged = await chooseSpeechDelivery(
					port.judge
						? async (...a) => {
								calls++;
								return port.judge!(...a);
							}
						: undefined,
					c.text,
					AbortSignal.timeout(8000),
					2000,
					{ answer: c.text, turns: c.turns },
				);
				result = {
					status:
						judged.emotion === c.expected.emotion &&
						judged.source !== "fallback"
							? "needs_semantic_review"
							: "failed",
					emotion: judged.emotion,
					source: judged.source,
					structureMatched: judged.emotion === c.expected.emotion,
					calls,
					safeCode: judged.reason ?? null,
					semanticChecks: "unchecked",
				};
			} else {
				for (const language of c.allowedLanguages)
					if (!asrLanguages.some(([code]) => code === language))
						throw new Error("invalid_evaluation_language");
				const h = await harness({ model: port });
				try {
					const subject = crypto.randomUUID();
					const id = await h.store.write((db) => {
						h.inference.captureInTransaction(
							db,
							subject,
							"llm",
							Date.now() + 8000,
						);
						return h.inference.captureControlInTransaction(db, {
							subject: subject + ":language",
							policySubject: subject,
							deadline: Date.now() + 8000,
							maxOutputTokens: 256,
						});
					});
					const receipt = await h.inference.executeControl(
						id,
						transcriptLanguageMessages(c.text),
						AbortSignal.timeout(8000),
					);
					const parsed = parseTranscriptLanguage(receipt.value);
					const status = transcriptLanguageStatus(
						parsed,
						c.allowedLanguages as any,
					);
					const accepted = await h.store.write((db) =>
						h.inference.acceptInTransaction(db, receipt),
					);
					const matched =
						accepted &&
						status === c.expected.status &&
						(!c.expected.languages ||
							JSON.stringify([...parsed.languages].sort()) ===
								JSON.stringify([...c.expected.languages].sort()));
					result = {
						status: matched ? "needs_semantic_review" : "failed",
						structureMatched: matched,
						languageStatus: status,
						languages: parsed.languages,
						calls: 1,
						model: h.inference
							.usage()
							.map((u) => ({ source: u.source, model: u.model })),
						semanticChecks: "unchecked",
						lane: "live_language_model_text_only",
					};
				} finally {
					await h.close();
				}
			}
			results.push({
				caseId: c.id,
				repeat,
				elapsedMs: Math.round(performance.now() - start),
				...result,
			});
			consecutiveFailures =
				result.status === "failed" ? consecutiveFailures + 1 : 0;
		} catch {
			results.push({
				caseId: c.id,
				repeat,
				status: "failed",
				safeCode: "live_evaluation_failed",
				semanticChecks: "unchecked",
				elapsedMs: Math.round(performance.now() - start),
			});
			consecutiveFailures++;
		} finally {
			await cleanupPort?.close();
		}
		if (consecutiveFailures >= 2) break casesLoop;
	}
}
mkdirSync(out, { recursive: true });
writeFileSync(
	join(out, "results.json"),
	JSON.stringify(
		{
			at: new Date().toISOString(),
			casesPath,
			repeats,
			lane: "live",
			accepted: false,
			results,
		},
		null,
		2,
	) + "\n",
	{ mode: 0o600 },
);
writeFileSync(
	join(out, "summary.md"),
	`# LLM Native live evaluation\n\n${results.length} runs; ${results.filter((r) => r.status === "skipped").length} skipped. Acceptance: incomplete. Semantic review is required; unchecked and skipped cases are never passes.\n\n` +
		results
			.map(
				(r) =>
					`- ${r.caseId} / ${r.repeat}: ${r.status}${r.safeCode ? " (" + r.safeCode + ")" : ""}`,
			)
			.join("\n") +
		"\n",
);
console.log(
	JSON.stringify({
		runs: results.length,
		skipped: results.filter((r) => r.status === "skipped").length,
		accepted: false,
	}),
);
if (results.some((r) => r.status === "failed")) process.exitCode = 1;
