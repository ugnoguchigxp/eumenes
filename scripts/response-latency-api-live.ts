import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTransport } from "../client/transport";
import { dialogueClient } from "../client/dialogue";
import { voiceDialogueClient } from "../client/voice-dialogue";
import { settingsClient } from "../client/settings";
import { larmClient } from "../client/larm";
import { liveLarmSettings } from "./live-larm";

if (import.meta.main) {
	if (!process.argv.includes("--run"))
		throw new Error("latency_api_live_requires_run");
	const saved = liveLarmSettings();
	const dir = mkdtempSync(join(tmpdir(), "eumenes-latency-"));
	const output = resolve("verification-reports/response-latency-api-live");
	mkdirSync(output, { recursive: true, mode: 0o700 });
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
			EUMENES_LOG_LEVEL: "info",
		},
		stdout: "ignore",
		stderr: "ignore",
	});
	const transport = createTransport(`http://127.0.0.1:${port}`, token);
	const client = {
		...dialogueClient(transport),
		...voiceDialogueClient(transport),
		...settingsClient(transport),
		...larmClient(transport),
	};
	const samples: Array<Record<string, unknown>> = [];
	let outcome = "ok";
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
		const settings = await client.settings();
		settings.larm = saved;
		for (const purpose of ["llm", "asr", "tts"] as const)
			settings.routes[purpose].mode = "larm-only";
		await client.applySettings({
			requestId: crypto.randomUUID(),
			expectedRevision: settings.revision,
			settings,
			keys: [],
		});
		for (let i = 0; i < 3; i++) {
			const started = performance.now();
			const run = await client.submit({
				requestId: crypto.randomUUID(),
				conversationId: `latency-${i}`,
				text: "日本の首都を一文で答えてください。",
			});
			let firstMs: number | undefined;
			await client.watchRun(run.id, AbortSignal.timeout(90_000), (value) => {
				if (value.text) firstMs ??= performance.now() - started;
			});
			const final = await client.run(run.id);
			samples.push({
				phase: "text_api",
				repetition: i,
				runId: run.id,
				status: final.status,
				firstTextMs: firstMs,
				totalMs: performance.now() - started,
			});
			console.log(JSON.stringify(samples.at(-1)));
			if (final.status !== "completed") throw new Error("text_probe_failed");
		}
		// Synthetic speech only; no user's recordings are read or saved.
		const wav = await client.replayAudio(
			"日本の首都を一文で答えてください。",
			AbortSignal.timeout(60_000),
		);
		for (let i = 0; i < 3; i++) {
			const sessionId = crypto.randomUUID(),
				utteranceId = crypto.randomUUID();
			await client.voiceStart(sessionId, 1);
			const started = performance.now();
			try {
				let turn = await client.voiceSend(sessionId, 1, 1, utteranceId, wav);
				let committed = false;
				let inputReadyMs: number | undefined;
				const deadline = Date.now() + 90_000;
				while (!turn.audioChunks?.length && Date.now() < deadline) {
					if (
						[
							"failed",
							"cancelled",
							"interrupted",
							"completed",
							"played",
						].includes(turn.status)
					)
						break;
					if (turn.status === "input_ready" && !committed) {
						inputReadyMs = performance.now() - started;
						await client.voiceCommit(utteranceId, turn.revision);
						committed = true;
					}
					await Bun.sleep(25);
					turn = await client.voiceTurn(utteranceId);
				}
				const firstChunk = turn.audioChunks?.[0];
				const readyMs = performance.now() - started;
				const bytes = firstChunk
					? await client.voiceAudio(utteranceId, firstChunk.index)
					: undefined;
				samples.push({
					phase: "voice_api",
					repetition: i,
					utteranceId,
					runId: turn.runId,
					status: turn.status,
					inputReadyMs,
					readyMs,
					audioReceivedMs: bytes ? performance.now() - started : undefined,
					bytes: bytes?.length,
				});
				console.log(JSON.stringify(samples.at(-1)));
				if (!bytes || bytes.length <= 44) throw new Error("voice_probe_failed");
			} finally {
				await client.voiceStop(sessionId, 1);
			}
		}
	} catch (error) {
		outcome =
			error instanceof Error &&
			[
				"isolated_backend_start_failed",
				"isolated_backend_start_timeout",
				"text_probe_failed",
				"voice_probe_failed",
			].includes(error.message)
				? error.message
				: "api_probe_failed";
		process.exitCode = 1;
	} finally {
		backend.kill("SIGTERM");
		const forced = setTimeout(() => backend.kill("SIGKILL"), 5000);
		await backend.exited;
		clearTimeout(forced);
		if (existsSync(join(dir, "api.jsonl")))
			copyFileSync(join(dir, "api.jsonl"), join(output, "backend.jsonl"));
		writeFileSync(
			join(output, "result.json"),
			JSON.stringify(
				{
					at: new Date().toISOString(),
					lane: "isolated_api_synthetic_audio_no_devices_tools_disabled",
					outcome,
					samples,
				},
				null,
				2,
			) + "\n",
			{ mode: 0o600 },
		);
		console.log(JSON.stringify({ outcome }));
		rmSync(dir, { recursive: true, force: true });
	}
}
