import { writeFileSync } from "node:fs";
import { createClient } from "../client";
import { readApiToken } from "../api/infrastructure/auth-config";

if (import.meta.main) {
	if (!process.argv.includes("--run"))
		throw new Error("voice_pair_live_requires_run");
	const client = createClient(
		"http://127.0.0.1:8787",
		readApiToken(process.env),
	);
	let settings = await client.settings();
	const original = { voice: settings.larm.voice, style: settings.larm.style };
	const japanese = await client.larmVoices(undefined, "ja");
	const english = await client.larmVoices(undefined, "en");
	const female = english.voices.find((v) => v.id === "Rosie");
	const male = english.voices.find((v) => v.id === "Jasper");
	if (
		female?.voice_presentation !== "feminine" ||
		male?.voice_presentation !== "masculine"
	)
		throw new Error("requested_voice_pair_unavailable");
	settings.larm.sentenceLanguageEnabled = true;
	settings = await client.applySettings({
		requestId: crypto.randomUUID(),
		expectedRevision: settings.revision,
		settings,
		keys: [],
	});
	const report: {
		date: string;
		samples: unknown[];
		result?: string;
		restored?: boolean;
	} = { date: new Date().toISOString(), samples: [] };
	try {
		for (const voice of japanese.voices) {
			if (
				!["feminine", "androgynous", "masculine"].includes(
					voice.voice_presentation ?? "",
				)
			)
				throw new Error("japanese_voice_presentation_unavailable");
			settings.larm.voice = voice.id;
			settings.larm.style = voice.default_style;
			settings = await client.applySettings({
				requestId: crypto.randomUUID(),
				expectedRevision: settings.revision,
				settings,
				keys: [],
			});
			const before = new Set((await client.inferenceUsage()).map((x) => x.id));
			const audio = await client.replayAudio(
				"This is the English voice for the selected character.",
				AbortSignal.timeout(60_000),
			);
			const expected =
				voice.voice_presentation === "masculine" ? male.id : female.id;
			const attempts = (await client.inferenceUsage()).filter(
				(x) => !before.has(x.id) && x.purpose === "tts",
			);
			if (attempts.length !== 1)
				throw new Error("voice_pair_attempt_ambiguous");
			const attempt = attempts[0]!;
			const speech = attempt.providerDetails?.find(
				(x) => x.operation === "audio/speech",
			);
			if (
				audio.length <= 44 ||
				attempt.status !== "succeeded" ||
				attempt.accepted !== 1 ||
				speech?.speechVoice !== expected ||
				speech.model !== english.model
			)
				throw new Error("voice_pair_live_mismatch");
			report.samples.push({
				japaneseVoice: voice.id,
				presentation: voice.voice_presentation,
				englishVoice: speech.speechVoice,
				model: attempt.model,
				accepted: attempt.accepted,
				bytes: audio.length,
				exchanges: attempt.providerDetails,
			});
		}
		report.result = "passed";
	} catch {
		report.result = "failed";
		process.exitCode = 1;
	} finally {
		const current = await client.settings();
		if (current.revision === settings.revision) {
			current.larm.voice = original.voice;
			current.larm.style = original.style;
			await client.applySettings({
				requestId: crypto.randomUUID(),
				expectedRevision: current.revision,
				settings: current,
				keys: [],
			});
			report.restored = true;
		} else {
			report.restored = false;
			process.exitCode = 1;
		}
		writeFileSync(
			"spec/verification/ruri-sentence-language-2026-10-12/voice-pair-live.json",
			JSON.stringify(report, null, 2),
		);
		console.log(JSON.stringify(report, null, 2));
	}
}
