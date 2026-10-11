import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createLiveLarm } from "./live-larm";
import { toErrorCode } from "../api/infrastructure/error-code";
import {
	parseTranscriptAssessment,
	transcriptLanguageMessages,
} from "../api/domains/voice-dialogue/service/transcript-language";

if (!process.argv.includes("--run"))
	throw new Error("use --run for live input assessment");
const out = resolve("verification-reports/voice-input-live");
mkdirSync(out, { recursive: true });
const larm = createLiveLarm();
const results: Array<Record<string, unknown>> = [];
try {
	await larm.connect();
	const cases = [
		{
			id: "fragment-1",
			text: "じゃあ今日は。",
			previousText: "",
			conversation: [],
			relation: "independent",
			readiness: "waiting",
		},
		{
			id: "fragment-2",
			text: "イラン側の。",
			previousText: "じゃあ今日は。",
			conversation: [],
			relation: "continuation",
			readiness: "waiting",
		},
		{
			id: "fragment-3",
			text: "最新のニュースを教えてください。",
			previousText: "じゃあ今日は。\nイラン側の。",
			conversation: [],
			relation: "continuation",
			readiness: "ready",
		},
		{
			id: "standalone",
			text: "今日の天気を教えてください。",
			previousText: "",
			conversation: [],
			relation: "independent",
			readiness: "ready",
		},
		{
			id: "independent",
			text: "東京の人口を教えてください。",
			previousText: "今日のニュースの",
			conversation: [],
			relation: "independent",
			readiness: "ready",
		},
		{
			id: "short-contextual-answer",
			text: "東京です。",
			previousText: "",
			conversation: [
				{ role: "assistant", text: "どこの天気を知りたいですか？" },
			],
			relation: "independent",
			readiness: "ready",
		},
	];
	for (const c of cases) {
		const started = performance.now();
		const raw = await larm.answer(
			transcriptLanguageMessages(c.text, {
				previousText: c.previousText,
				conversation: c.conversation,
			}),
			AbortSignal.timeout(8000),
			{ maxOutputTokens: 512 },
		);
		const a = parseTranscriptAssessment(raw);
		const pass =
			a.status === "identified" &&
			a.languages.includes("ja") &&
			a.confidence >= 0.8 &&
			a.relation === c.relation &&
			a.relationConfidence >= 0.8 &&
			a.readiness === c.readiness &&
			a.readinessConfidence >= 0.8;
		const result = {
			id: c.id,
			relation: a.relation,
			readiness: a.readiness,
			relationConfidence: a.relationConfidence,
			readinessConfidence: a.readinessConfidence,
			ms: Math.round(performance.now() - started),
			pass,
		};
		results.push(result);
		console.log(JSON.stringify(result));
		writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
	}
	if (results.some((r) => !r.pass)) process.exitCode = 1;
} catch (error) {
	const result = {
		pass: false,
		reason: toErrorCode(error, "live_input_unavailable"),
	};
	results.push(result);
	writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
	console.log(JSON.stringify(result));
	process.exitCode = 1;
} finally {
	await larm.close();
}
