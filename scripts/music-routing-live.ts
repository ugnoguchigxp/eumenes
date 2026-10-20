import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createLarmPlayground, findServiceTarget } from "../api/domains/larm";
import { resolveLarmToken } from "../api/infrastructure/auth-config";
import type { TestInput } from "../api/domains/larm/contracts/playground";
import { liveLarmSettings } from "./live-larm";
if (!process.argv.includes("--run"))
	throw new Error("use --run for three live generations, one POST per use");
const output = resolve(
	"verification-reports/music-routing-live",
	new Date().toISOString().replaceAll(":", "-"),
);
mkdirSync(output, { recursive: true });
const saved = liveLarmSettings();
const gateway = createLarmPlayground({
	...saved,
	baseUrl: saved.baseUrl ?? undefined,
	voice: saved.voice ?? undefined,
	token: resolveLarmToken(process.env),
});
const signal = AbortSignal.timeout(15 * 60 * 1000);
const providers = await gateway.musicProviders(signal);
const target = findServiceTarget(
	(await gateway.catalog(signal)).targets,
	"media.music.generate",
	"larm.music-generation.v1",
);
if (!target?.description) throw new Error("music_service_unavailable");
const inputs: { use: string; input: TestInput }[] = [
	{
		use: "instrumental",
		input: {
			text: "Gentle orchestral instrumental music with strings and a soft piano, no singing",
			task: "music",
			instrumental: true,
			durationSeconds: 5,
		},
	},
	{
		use: "vocals",
		input: {
			text: "Gentle pop song with a clear singing voice and soft piano",
			task: "music",
			instrumental: false,
			lyrics: "Hello, a new day begins",
			language: "en",
			durationSeconds: 5,
		},
	},
	{
		use: "sound-effect",
		input: {
			text: "Short futuristic user interface confirmation chime with a bright gentle tail",
			task: "sound-effect",
			durationSeconds: 1.5,
		},
	},
];
const results: Record<string, unknown>[] = [];
const report = () =>
	writeFileSync(
		`${output}/results.json`,
		JSON.stringify({ providers, results }, null, 2) + "\n",
	);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
	browser = await chromium.launch({
		headless: true,
		args: ["--autoplay-policy=no-user-gesture-required"],
	});
	const page = await browser.newPage();
	await page.setContent(
		"<!doctype html><title>Audio playback acceptance</title>",
	);
	for (const { use, input } of inputs) {
		const phases: string[] = [];
		let jobId: string | undefined;
		const started = Date.now();
		try {
			const audio = await gateway.execute(
				target,
				input,
				signal,
				async (progress) => {
					jobId = progress.jobId ?? jobId;
					if (phases.at(-1) !== progress.phase) {
						phases.push(progress.phase);
						console.log(JSON.stringify({ use, phase: progress.phase, jobId }));
					}
				},
			);
			if (!audio.bytes || !audio.artifact)
				throw new Error("music_audio_missing");
			const path = `${output}/${use}.opus`;
			writeFileSync(path, audio.bytes);
			const probe = Bun.spawnSync([
				"ffprobe",
				"-v",
				"error",
				"-show_entries",
				"format=duration",
				"-of",
				"json",
				path,
			]);
			if (probe.exitCode !== 0) throw new Error("audio_probe_failed");
			const measuredSeconds = Number(
				JSON.parse(probe.stdout.toString()).format.duration,
			);
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
			const playback = await page.evaluate(
				async ({ content, mime }) => {
					const url = URL.createObjectURL(
						new Blob([new Uint8Array(content)], { type: mime }),
					);
					const element = new Audio(url);
					try {
						const ended = new Promise<void>((resolve, reject) => {
							element.onended = () => resolve();
							element.onerror = () =>
								reject(new Error("audio_playback_failed"));
							setTimeout(
								() => reject(new Error("audio_playback_timeout")),
								30000,
							);
						});
						await element.play();
						await ended;
						return {
							currentTime: element.currentTime,
							ended: element.ended,
							duration: element.duration,
						};
					} finally {
						element.pause();
						URL.revokeObjectURL(url);
					}
				},
				{ content: Array.from(audio.bytes), mime: audio.mime ?? "audio/ogg" },
			);
			if (!playback.ended || playback.currentTime < 1)
				throw new Error("audio_playback_incomplete");
			results.push({
				use,
				status: "completed",
				jobId,
				requestedSeconds: input.durationSeconds,
				measuredSeconds,
				model: audio.actualModel,
				runtime: audio.runtime,
				bytes: audio.bytes.length,
				playback,
				phases,
				elapsedMs: Date.now() - started,
				path,
			});
			report();
			// Remove only this acceptance run's newly generated track; its local evidence is retained.
			await gateway.library.remove(
				audio.artifact.id,
				AbortSignal.timeout(15000),
			);
			results.at(-1)!.testTrackRemoved = true;
			report();
			console.log(JSON.stringify(results.at(-1)));
		} catch (error) {
			results.push({
				use,
				status: "failed",
				jobId,
				phases,
				error: error instanceof Error ? error.message : "unknown",
				elapsedMs: Date.now() - started,
			});
			report();
			console.log(JSON.stringify(results.at(-1)));
			process.exitCode = 1;
		}
	}
} finally {
	await browser?.close();
}
console.log(JSON.stringify({ report: `${output}/results.json` }));
