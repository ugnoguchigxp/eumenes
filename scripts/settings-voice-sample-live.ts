import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "../client";
import { readApiToken } from "../api/infrastructure/auth-config";
import { toErrorCode } from "../api/infrastructure/error-code";

/** Exercise the normal backend and its existing claimed providers. Never write preferences. */
if (import.meta.main) {
	if (!process.argv.includes("--run"))
		throw new Error("settings_voice_sample_live_requires_run");
	const port = Number(process.env.EUMENES_PORT || 8787);
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error("invalid_api_port");
	const client = createClient(
		`http://127.0.0.1:${port}`,
		readApiToken(process.env),
	);
	const output = resolve("spec/verification/settings-voice-input-2026-10-13");
	mkdirSync(output, { recursive: true });
	const results: Record<string, unknown>[] = [];
	let phase = "read-settings",
		unchanged = false,
		classifier = false;
	try {
		const baseline = await client.settings();
		classifier = !!baseline.larm.sentenceLanguageEnabled;
		if (!classifier) throw new Error("saved_sentence_language_not_enabled");
		phase = "catalog";
		const catalog = await client.larmVoices();
		if (!catalog.voices.length || catalog.voices.length > 16)
			throw new Error("live_voice_case_budget_exceeded");
		for (const voice of catalog.voices) {
			phase = "sample:" + voice.id;
			const range = voice.capabilities.speed;
			const speed = Math.min(
				range?.maximum ?? 2,
				Math.max(
					range?.minimum ?? 0.5,
					baseline.larm.speed === 1.1 ? 1.2 : 1.1,
				),
			);
			const started = performance.now();
			const wav = await client.voiceSample(
				{
					voice: voice.id,
					style: voice.default_style ?? null,
					speed,
					pitchScale: voice.capabilities.pitch_scale?.default,
					intonationScale: voice.capabilities.intonation_scale?.default,
				},
				AbortSignal.timeout(45000),
			);
			const pass =
				wav.length > 44 &&
				String.fromCharCode(...wav.subarray(0, 4)) === "RIFF" &&
				String.fromCharCode(...wav.subarray(8, 12)) === "WAVE" &&
				wav.subarray(44).some((v) => v !== 0);
			const result = {
				voice: voice.id,
				style: voice.default_style,
				speed,
				bytes: wav.length,
				elapsedMs: Math.round(performance.now() - started),
				pass,
			};
			results.push(result);
			console.log(JSON.stringify(result));
			if (!pass) throw new Error("sample_audio_invalid");
		}
		unchanged =
			JSON.stringify(await client.settings()) === JSON.stringify(baseline);
		if (!unchanged) throw new Error("saved_settings_changed_during_check");
	} catch (error) {
		const result = {
			pass: false,
			phase,
			error: toErrorCode(error, "live_sample_failed"),
		};
		results.push(result);
		console.log(JSON.stringify(result));
		process.exitCode = 1;
	} finally {
		writeFileSync(
			resolve(output, "sample-current-api-results.json"),
			JSON.stringify(
				{
					date: new Date().toISOString(),
					lane: "current-api-real-larm",
					classifier,
					unchanged,
					results,
				},
				null,
				2,
			),
		);
	}
}
