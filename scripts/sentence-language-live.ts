import { benchmarkSentenceLanguage } from "./sentence-language-bench";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLiveLarm, liveLarmSettings } from "./live-larm";
import type { LarmExchange } from "../api/domains/larm";

/** Uses saved backend settings and public profile/claim/auth; never a local model CLI. */
if (import.meta.main) {
	if (!process.argv.includes("--run"))
		throw new Error("sentence_language_live_requires_run");
	const saved = liveLarmSettings();
	const larm = createLiveLarm();
	const output = resolve("verification-reports/sentence-language-live");
	mkdirSync(output, { recursive: true });
	const report: Record<string, unknown> = {
		date: new Date().toISOString(),
		profile: saved.profile,
		classifier: "pending",
		samples: [],
	};
	const samples = report.samples as unknown[];
	try {
		const routing = await larm.speechRouting!(AbortSignal.timeout(10_000));
		report.discovery = routing;
		const published = saved.sentenceLanguageProvider
			? routing.languageProviders.some(
					(p) => p.name === saved.sentenceLanguageProvider,
				)
			: routing.languageProviders.length === 1;
		report.classifier = published
			? "ready_for_check"
			: "selected_provider_not_published";
		const preparedAt = performance.now();
		await larm.prepareVoice!(AbortSignal.timeout(60_000));
		report.admissionMs = performance.now() - preparedAt;
		for (const [language, text] of [
			["ja", "日本語の音声接続を確認します。"],
			["en", "This is an English speech connection check."],
		] as const) {
			if (language === "en" && !routing.englishTts) {
				samples.push({ language, status: "provider_not_published" });
				continue;
			}
			const exchanges: LarmExchange[] = [];
			const signal = AbortSignal.timeout(90_000);
			const options = {
				onExchange: async (exchange: LarmExchange) => {
					exchanges.push(exchange);
				},
			};
			let selectedLanguage: "ja" | "en" = language;
			if (published) {
				const decision = await larm.classifySentenceLanguage!(
					text,
					signal,
					options,
				);
				if (decision.language !== language)
					throw new Error("live_language_label_mismatch");
				selectedLanguage = decision.language;
				report.classifier = "labels_passed";
				samples.push({ language, status: "classified", decision });
			}
			const start = performance.now();
			// Published classifiers choose the TTS; legacy runs with no classifier only check TTS transport.
			const bytes = await larm.speak(text, signal, {
				...options,
				speechLanguage: selectedLanguage,
			});
			if (bytes.length <= 44) throw new Error("live_audio_empty");
			writeFileSync(join(output, `${language}.wav`), bytes);
			samples.push({
				language,
				status: "wav_received",
				bytes: bytes.length,
				ms: Math.round(performance.now() - start),
				exchanges,
			});
		}
		if (published && process.argv.includes("--benchmark"))
			report.benchmark = await benchmarkSentenceLanguage(larm);
		report.result = published
			? "public_transport_passed"
			: "tts_passed_classifier_pending";
	} catch (error) {
		report.result = "failed";
		report.error =
			error instanceof Error && /^[a-z][a-z0-9_]{0,100}$/.test(error.message)
				? error.message
				: "live_check_failed";
		process.exitCode = 1;
	} finally {
		await larm.close();
		writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2));
		console.log(JSON.stringify(report, null, 2));
	}
}
