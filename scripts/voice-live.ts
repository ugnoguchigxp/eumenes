import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient } from "../client";
import {
	readApiToken,
	resolveLarmToken,
} from "../api/infrastructure/auth-config";

if (process.env.EUMENES_LIVE_VOICE !== "1" || !resolveLarmToken(process.env))
	throw new Error("live_voice_requires_explicit_flag_and_larm_token");
const dir = mkdtempSync(join(tmpdir(), "eumenes-live-voice-"));
const reservation = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () => new Response(),
});
const port = reservation.port;
reservation.stop(true);
const backend = Bun.spawn([process.execPath, "api/application/server.ts"], {
	env: {
		...process.env,
		EUMENES_DB: join(dir, "db.sqlite3"),
		EUMENES_ATTITUDE_DATASET: join(dir, "attitude.sqlite3"),
		EUMENES_MEMORY_JOURNAL: join(dir, "journal.jsonl"),
		EUMENES_LOG_FILE: join(dir, "api.jsonl"),
		EUMENES_HOST: "127.0.0.1",
		EUMENES_PORT: String(port),
		EUMENES_TOOLCHAIN_ENABLED: "1",
	},
	stdout: "ignore",
	stderr: "ignore",
});
const client = createClient(
	`http://127.0.0.1:${port}`,
	readApiToken(
		process.env,
		resolve(import.meta.dir, "../data/eumenes.sqlite3"),
	),
);
const output = "verification-reports/voice-live";
mkdirSync(output, { recursive: true });
try {
	let ready = false;
	for (let attempt = 0; attempt < 100; attempt++) {
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
	const connection = await client.connectLarm();
	if (connection.larm.state !== "ready")
		throw new Error("isolated_larm_not_ready");
	// Use real synthesized input rather than copying a user's microphone recording.
	const input = await client.replayAudio("今日の鎌倉の天気を教えてください。");
	const sessionId = crypto.randomUUID(),
		utteranceId = crypto.randomUUID();
	await client.voiceStart(sessionId, 1);
	await client.voiceSend(sessionId, 1, 1, utteranceId, input);
	const deadline = Date.now() + 240_000;
	let turn = await client.voiceTurn(utteranceId);
	while (
		Date.now() < deadline &&
		["recognizing", "responding", "synthesizing"].includes(turn.status)
	) {
		await Bun.sleep(250);
		turn = await client.voiceTurn(utteranceId);
	}
	const run = turn.runId ? await client.run(turn.runId) : null;
	const history = await client.conversation("main");
	const answer = history.messages.find(
		(message) => message.id === run?.answerMessageId,
	)?.text;
	const task = run?.agentTaskId
		? await client.agentReport(run.agentTaskId).catch(() => null)
		: null;
	const audio =
		turn.status === "ready" ? await client.voiceAudio(utteranceId) : null;
	const hasWav =
		!!audio &&
		audio.length > 44 &&
		new TextDecoder().decode(audio.subarray(0, 4)) === "RIFF";
	const spoken = turn.audioChunks?.map((chunk) => chunk.text).join("");
	const ok =
		turn.status === "ready" &&
		run?.status === "completed" &&
		!!turn.text?.includes("鎌倉") &&
		!!turn.text.includes("天気") &&
		!!answer &&
		spoken === answer &&
		!!task?.claims.length &&
		hasWav;
	const result = {
		mode: "real_tts_asr_llm_web_tts_isolated_backend",
		at: new Date().toISOString(),
		ok,
		status: turn.status,
		error: turn.error,
		runStatus: run?.status,
		transcript: turn.text,
		answer,
		spoken,
		audioBytes: audio?.length,
		claims: task?.claims,
		sources: task?.sources,
	};
	writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2), {
		mode: 0o600,
	});
	console.log(JSON.stringify(result));
	if (!ok) process.exitCode = 1;
} finally {
	backend.kill("SIGTERM");
	await Promise.race([backend.exited, Bun.sleep(12_000)]);
	if (backend.exitCode === null) {
		backend.kill("SIGKILL");
		await backend.exited;
	}
	if (existsSync(join(dir, "api.jsonl")))
		writeFileSync(
			join(output, "backend.jsonl"),
			readFileSync(join(dir, "api.jsonl")),
			{ mode: 0o600 },
		);
	rmSync(dir, { recursive: true, force: true });
}
