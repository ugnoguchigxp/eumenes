import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createLiveLarm } from "./live-larm";
import { configureLogging, withLogContext } from "../api/infrastructure/logger";
import { measureStage } from "../api/infrastructure/performance";

/** Backend-only probe. Saved settings are read through the settings domain. */
if (import.meta.main) {
	if (!process.argv.includes("--run"))
		throw new Error("latency_live_requires_run");
	const output = resolve("verification-reports/response-latency-live");
	mkdirSync(output, { recursive: true, mode: 0o700 });
	configureLogging({
		file: join(output, "backend.jsonl"),
		destination: { write() {} },
	});
	const port = createLiveLarm();
	const samples: Array<Record<string, unknown>> = [];
	let wav: Uint8Array | undefined;
	try {
		// First request includes this client's lease preparation; later requests reuse it.
		for (let repetition = 0; repetition < 3; repetition++) {
			for (const [phase, purpose] of [
				["tts", "tts"],
				["asr", "asr"],
				["llm", "llm"],
			] as const) {
				const sampleId = crypto.randomUUID();
				await withLogContext({ subjectId: sampleId, purpose }, async () => {
					const started = performance.now();
					let firstAt: number | undefined;
					try {
						const result = await measureStage(
							"latency-probe",
							phase,
							async () => {
								const signal = AbortSignal.timeout(60_000);
								if (phase === "tts") {
									wav = await port.speak(
										"こんにちは。今日は良い天気ですね。",
										signal,
									);
									return wav.length;
								}
								if (phase === "asr") {
									if (!wav) throw new Error("probe_audio_missing");
									return (await port.transcribe(wav, signal)).length;
								}
								const messages = [
									{
										role: "user" as const,
										content: "日本の首都を一文で答えてください。",
									},
								];
								return (
									await port.answerStream!(
										messages,
										signal,
										(delta) => {
											if (delta) firstAt ??= performance.now();
										},
										{ maxOutputTokens: 128 },
									)
								).length;
							},
						);
						samples.push({
							sampleId,
							phase,
							repetition,
							outcome: "ok",
							durationMs: performance.now() - started,
							...(firstAt === undefined
								? {}
								: { firstDeltaMs: firstAt - started }),
							outputSize: result,
						});
					} catch {
						// Error classification is in the safe operational log; never serialize exceptions.
						samples.push({
							sampleId,
							phase,
							repetition,
							outcome: "error",
							durationMs: performance.now() - started,
						});
						process.exitCode = 1;
					}
					console.log(JSON.stringify(samples.at(-1)));
				});
			}
		}
	} finally {
		await port.close();
		writeFileSync(
			join(output, "result.json"),
			JSON.stringify(
				{
					at: new Date().toISOString(),
					lane: "live_adapter_synthetic_audio_no_devices",
					samples,
				},
				null,
				2,
			) + "\n",
			{ mode: 0o600 },
		);
	}
}
