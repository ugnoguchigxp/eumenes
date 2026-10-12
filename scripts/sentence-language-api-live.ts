import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient } from "../client";
import { liveLarmSettings } from "./live-larm";

if (import.meta.main) {
	if (!process.argv.includes("--run"))
		throw new Error("sentence_language_api_live_requires_run");
	const saved = liveLarmSettings();
	const dir = mkdtempSync(join(tmpdir(), "eumenes-ruri-api-"));
	const output = resolve("verification-reports/sentence-language-api-live");
	mkdirSync(output, { recursive: true });
	const reservation = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	const port = reservation.port;
	reservation.stop(true);
	const token = crypto.randomUUID() + crypto.randomUUID();
	const backend = Bun.spawn([process.execPath, "api/application/server.ts"], {
		env: {
			...process.env,
			EUMENES_HOST: "127.0.0.1",
			EUMENES_PORT: String(port),
			EUMENES_DB: join(dir, "db.sqlite3"),
			EUMENES_KEY_DIR: join(dir, "keys"),
			EUMENES_API_TOKEN: token,
			EUMENES_ATTITUDE_DATASET: join(dir, "attitude.sqlite3"),
			EUMENES_MEMORY_JOURNAL: join(dir, "memory.jsonl"),
			EUMENES_WORLD_JOURNAL: join(dir, "world.jsonl"),
			EUMENES_LOG_FILE: join(dir, "api.jsonl"),
			EUMENES_TOOLCHAIN_ENABLED: "0",
		},
		stdout: "ignore",
		stderr: "ignore",
	});
	const client = createClient(`http://127.0.0.1:${port}`, token);
	const report: Record<string, unknown> = {
		date: new Date().toISOString(),
		profile: saved.profile,
		samples: [],
	};
	try {
		let ready = false;
		for (let i = 0; i < 100; i++) {
			if (backend.exitCode !== null)
				throw new Error("isolated_backend_start_failed");
			try {
				await client.status();
				ready = true;
				break;
			} catch {
				await Bun.sleep(100);
			}
		}
		if (!ready) throw new Error("isolated_backend_start_timeout");
		let settings = await client.settings();
		settings.larm = { ...saved, sentenceLanguageEnabled: false };
		for (const purpose of ["llm", "asr", "tts"] as const)
			settings.routes[purpose].mode = "larm-only";
		settings = await client.applySettings({
			requestId: crypto.randomUUID(),
			expectedRevision: settings.revision,
			settings,
			keys: [],
		});
		const routing = await client.speechRouting();
		const provider =
			routing.languageProviders.find(
				(p) => p.name === saved.sentenceLanguageProvider,
			) ??
			(routing.languageProviders.length === 1
				? routing.languageProviders[0]
				: undefined);
		if (!provider || !routing.englishTts)
			throw new Error("public_speech_provider_missing");
		settings.larm.sentenceLanguageProvider = provider.name;
		settings.larm.sentenceLanguageEnabled = true;
		await client.applySettings({
			requestId: crypto.randomUUID(),
			expectedRevision: settings.revision,
			settings,
			keys: [],
		});
		report.provider = provider;
		for (const [language, text, model] of [
			["ja", "日本語の読み上げを確認します。", "voicevox-core"],
			[
				"en",
				"This is an English speech connection check.",
				"kitten-tts-nano-0.8-fp32",
			],
		] as const) {
			const bytes = await client.replayAudio(text, AbortSignal.timeout(60_000));
			if (
				bytes.length <= 44 ||
				new TextDecoder().decode(bytes.slice(0, 4)) !== "RIFF"
			)
				throw new Error("api_audio_invalid");
			writeFileSync(join(output, `${language}.wav`), bytes);
			const attempt = (await client.inferenceUsage()).find(
				(x) => x.purpose === "tts" && x.accepted === 1 && x.model === model,
			);
			if (
				!attempt ||
				!attempt.providerDetails?.some(
					(x) => x.operation === "systemone" && x.model === provider.model,
				) ||
				!attempt.providerDetails.some(
					(x) => x.operation === "audio/speech" && x.model === model,
				)
			)
				throw new Error("api_speech_receipt_invalid");
			(report.samples as unknown[]).push({
				language,
				bytes: bytes.length,
				model: attempt.model,
				accepted: attempt.accepted,
				exchanges: attempt.providerDetails,
			});
		}
		report.result = "public_api_routing_passed";
	} catch (error) {
		report.result = "failed";
		report.error =
			error instanceof Error && /^[a-z][a-z0-9_]{0,100}$/.test(error.message)
				? error.message
				: "api_live_failed";
		process.exitCode = 1;
	} finally {
		backend.kill("SIGTERM");
		const forced = setTimeout(() => backend.kill("SIGKILL"), 5000);
		await backend.exited;
		clearTimeout(forced);
		writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2));
		console.log(JSON.stringify(report, null, 2));
		rmSync(dir, { recursive: true, force: true });
	}
}
