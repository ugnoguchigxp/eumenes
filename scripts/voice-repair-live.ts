import { mkdirSync, writeFileSync } from "node:fs";
import { createLiveLarm } from "./live-larm";
import { configureLogging, flushLogging } from "../api/infrastructure/logger";
import { toErrorCode } from "../api/infrastructure/error-code";

/** Synthetic speech only, using saved settings in this process; never starts an API server. */
if (import.meta.main) {
	if (!process.argv.includes("--run")) throw new Error("live_requires_run");
	const directory = "verification-reports/voice-repair-2026-10-25";
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	configureLogging({
		file: `${directory}/asr-live-fixed.jsonl`,
		destination: { write() {} },
	});
	const port = createLiveLarm();
	const results: Record<string, unknown>[] = [];
	try {
		const encoded = await port.speak(
			"カレーを作りました。設計にはCADを使います。",
			AbortSignal.timeout(60_000),
		);
		const decoded = Bun.spawnSync(
			[
				"ffmpeg",
				"-v",
				"error",
				"-i",
				"pipe:0",
				"-ar",
				"16000",
				"-ac",
				"1",
				"-f",
				"s16le",
				"pipe:1",
			],
			{ stdin: encoded },
		);
		if (decoded.exitCode !== 0) throw new Error("audio_decode_failed");
		const phrase = new Uint8Array(decoded.stdout);
		if (!phrase.length || phrase.length > 32000 * 10)
			throw new Error("synthetic_phrase_duration_invalid");
		// Complete repeated phrases with silence; the long input stays one adopted transcript.
		const repetitions = Math.ceil((16 * 32000) / (phrase.length + 32000));
		const data = new Uint8Array(repetitions * (phrase.length + 32000));
		for (let i = 0; i < repetitions; i++)
			data.set(phrase, i * (phrase.length + 32000));
		const wav = new Uint8Array(44 + data.length);
		const h = new DataView(wav.buffer);
		for (const [offset, tag] of [
			[0, "RIFF"],
			[8, "WAVE"],
			[12, "fmt "],
			[36, "data"],
		] as const)
			wav.set(new TextEncoder().encode(tag), offset);
		h.setUint32(4, wav.length - 8, true);
		h.setUint32(16, 16, true);
		h.setUint16(20, 1, true);
		h.setUint16(22, 1, true);
		h.setUint32(24, 16000, true);
		h.setUint32(28, 32000, true);
		h.setUint16(32, 2, true);
		h.setUint16(34, 16, true);
		h.setUint32(40, data.length, true);
		wav.set(data, 44);
		let requests = 0;
		const started = performance.now();
		const transcript = await port.transcribe(wav, AbortSignal.timeout(60_000), {
			onExchange: async () => {
				requests++;
			},
		});
		const phraseCount = transcript.match(/カレー/g)?.length ?? 0;
		results.push({
			lane: "live_adapter_synthetic_no_devices",
			seconds: data.length / 32000,
			requests,
			repetitions,
			phraseCount,
			precisionAccepted: false,
			transcript,
			durationMs: performance.now() - started,
			pass: !!transcript.trim() && phraseCount === repetitions,
		});
		if (!transcript.trim() || phraseCount !== repetitions)
			throw new Error("synthetic_phrase_missing");
	} catch (error) {
		results.push({ pass: false, code: toErrorCode(error, "live_failed") });
		process.exitCode = 1;
	} finally {
		await port.close();
		await flushLogging();
		writeFileSync(
			`${directory}/synthetic-live.json`,
			JSON.stringify(results, null, 2),
			{ mode: 0o600 },
		);
		for (const result of results) console.log(JSON.stringify(result));
	}
}
