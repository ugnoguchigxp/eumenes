import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { notificationSoundIds } from "../api/domains/settings/contracts/notification-sounds";
const browser = await chromium.launch({
	headless: true,
	args: ["--autoplay-policy=no-user-gesture-required"],
});
const results: unknown[] = [];
try {
	const page = await browser.newPage();
	await page.setContent(
		"<!doctype html><title>Notification audio acceptance</title>",
	);
	for (const id of notificationSoundIds.filter((id) => id !== "beep")) {
		const path = `web/src/domains/settings/sounds/${id}.wav`;
		const probe = Bun.spawnSync([
			"ffprobe",
			"-v",
			"error",
			"-show_entries",
			"format=duration:stream=sample_rate,channels",
			"-of",
			"json",
			path,
		]);
		if (probe.exitCode !== 0) throw new Error("audio_probe_failed");
		const measurement = JSON.parse(probe.stdout.toString());
		const duration = Number(measurement.format.duration);
		if (duration < 1 || duration > 2) throw new Error("audio_duration_invalid");
		const decoded = Bun.spawnSync([
			"ffmpeg",
			"-v",
			"error",
			"-i",
			path,
			"-f",
			"null",
			"-",
		]);
		if (decoded.exitCode !== 0) throw new Error("audio_decode_failed");
		const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
		const playback = await page.evaluate(async (content) => {
			const data = new Uint8Array(content);
			const context = new AudioContext();
			const buffer = await context.decodeAudioData(data.slice().buffer);
			const samples = buffer.getChannelData(0);
			let peak = 0,
				square = 0;
			for (const value of samples) {
				peak = Math.max(peak, Math.abs(value));
				square += value * value;
			}
			await context.close();
			const url = URL.createObjectURL(new Blob([data], { type: "audio/wav" }));
			const audio = new Audio(url);
			try {
				await Promise.race([
					(async () => {
						const ended = new Promise<void>((resolve, reject) => {
							audio.onended = () => resolve();
							audio.onerror = () => reject(new Error("playback_failed"));
						});
						await audio.play();
						await ended;
					})(),
					new Promise((_, reject) =>
						setTimeout(() => reject(new Error("playback_timeout")), 10000),
					),
				]);
				return {
					ended: audio.ended,
					currentTime: audio.currentTime,
					peak,
					rms: Math.sqrt(square / samples.length),
				};
			} finally {
				audio.pause();
				URL.revokeObjectURL(url);
			}
		}, Array.from(bytes));
		if (!playback.ended || playback.peak >= 1 || playback.rms < 0.001)
			throw new Error("audio_level_invalid");
		results.push({ id, measurement, playback, bytes: bytes.length });
	}
} finally {
	await browser.close();
}
writeFileSync(
	"verification-reports/notification-sounds/audio-check.json",
	JSON.stringify(results, null, 2) + "\n",
);
console.log(JSON.stringify({ checked: results.length, status: "passed" }));
