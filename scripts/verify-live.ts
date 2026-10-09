import { readFileSync } from "node:fs";
import { createLarm } from "../api/domains/larm";
import { resolveLarmToken } from "../api/infrastructure/auth-config";

const args = process.argv.slice(2).filter((x) => x !== "--");
if (args[0] === "--domain" && args[1] === "agent-runtime") {
	await import("./toolchain-live");
	process.exit(process.exitCode ?? 0);
}
if (args[0] === "--domain" && args[1] === "research-routes") {
	await import("./research-routes-live");
	process.exit(process.exitCode ?? 0);
}
if (args[0] !== "--domain" || args[1] !== "larm") {
	console.error("Use --domain larm|agent-runtime|research-routes");
	process.exit(2);
}
const path = process.env.EUMENES_LIVE_ASR_WAV;
if (!process.env.LARM_BASE_URL || !resolveLarmToken(process.env) || !path) {
	console.error(
		"Live verification requires LARM_BASE_URL, LARM_CONTROL_TOKEN or LARM_API_TOKEN, and EUMENES_LIVE_ASR_WAV. No fixture fallback is used.",
	);
	process.exit(2);
}
const larm = createLarm({
	baseUrl: process.env.LARM_BASE_URL,
	token: resolveLarmToken(process.env),
	profile: process.env.LARM_PROFILE,
	audience: process.env.LARM_AUDIENCE,
	voice: process.env.EUMENES_TTS_VOICE,
});
try {
	const signal = new AbortController().signal;
	const asrStarted = performance.now();
	const text = await larm.transcribe(
		new Uint8Array(readFileSync(path)),
		signal,
	);
	const asrMs = Math.round(performance.now() - asrStarted);
	const expected = process.env.EUMENES_LIVE_EXPECT_TEXT;
	if (expected && !text.includes(expected))
		throw new Error("live_asr_expected_text_missing");
	const llmStarted = performance.now();
	const answer = await larm.answer([{ role: "user", content: text }], signal);
	const llmMs = Math.round(performance.now() - llmStarted);
	const ttsStarted = performance.now();
	const audio = await larm.speak(answer, signal);
	const ttsMs = Math.round(performance.now() - ttsStarted);
	console.log(
		JSON.stringify({
			asr: {
				ok: !!text,
				length: text.length,
				expectedTextMatched: expected ? text.includes(expected) : null,
				ms: asrMs,
			},
			llm: { ok: !!answer, length: answer.length, ms: llmMs },
			tts: { ok: audio.length >= 44, bytes: audio.length, ms: ttsMs },
			voiceLoop: "individual operations only; browser playback not verified",
		}),
	);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	await larm.close();
}
