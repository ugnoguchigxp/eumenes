import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient } from "../client";
import { speechLanguage } from "../api/domains/delivery";
import { liveLarmSettings } from "./live-larm";

/** Mixed Japanese/English answer: each clause part must reach the voice of its language. */
const ANSWER =
	"設定画面を開いたら、Open the settings を押してください。API キーは Docker の環境変数に入れます。Thank you for waiting. 以上です。";

if (import.meta.main) {
	if (!process.argv.includes("--run"))
		throw new Error("mixed_speech_live_requires_run");
	const saved = liveLarmSettings();
	const dir = mkdtempSync(join(tmpdir(), "eumenes-mixed-speech-"));
	const output = resolve("verification-reports/mixed-speech-live");
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
		answer: ANSWER,
		segments: [],
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
		settings.larm = { ...saved, englishSpeechEnabled: true };
		for (const purpose of ["llm", "asr", "tts"] as const)
			settings.routes[purpose].mode = "larm-only";
		settings = await client.applySettings({
			requestId: crypto.randomUUID(),
			expectedRevision: settings.revision,
			settings,
			keys: [],
		});
		const models = {
			ja: (await client.larmVoices(undefined, "ja")).model,
			en: (await client.larmVoices(undefined, "en")).model,
		};
		if (!models.ja || !models.en || models.ja === models.en)
			throw new Error("speech_voices_not_distinct");
		report.models = models;
		const parts = await client.replaySentences(ANSWER);
		const languages = new Set(parts.map(speechLanguage));
		if (!languages.has("ja") || !languages.has("en"))
			throw new Error("mixed_answer_not_split");
		for (const [i, text] of parts.entries()) {
			const language = speechLanguage(text);
			const before = new Set((await client.inferenceUsage()).map((x) => x.id));
			const bytes = await client.replayAudio(text, AbortSignal.timeout(60_000));
			if (
				bytes.length <= 44 ||
				new TextDecoder().decode(bytes.slice(0, 4)) !== "RIFF"
			)
				throw new Error("api_audio_invalid");
			writeFileSync(join(output, `${i}-${language}.wav`), bytes);
			const attempt = (await client.inferenceUsage()).find(
				(x) => !before.has(x.id) && x.purpose === "tts" && x.accepted === 1,
			);
			if (!attempt || attempt.model !== models[language])
				throw new Error("api_speech_route_invalid");
			(report.segments as unknown[]).push({
				text,
				language,
				bytes: bytes.length,
				model: attempt.model,
			});
		}
		report.result = "mixed_speech_routing_passed";
	} catch (error) {
		report.result = "failed";
		report.error =
			error instanceof Error && /^[a-z][a-z0-9_]{0,100}$/.test(error.message)
				? error.message
				: "mixed_speech_live_failed";
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
