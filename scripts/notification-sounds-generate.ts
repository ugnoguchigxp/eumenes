import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createLarmPlayground, findServiceTarget } from "../api/domains/larm";
import { resolveLarmToken } from "../api/infrastructure/auth-config";
import { liveLarmSettings } from "./live-larm";

if (!process.argv.includes("--run"))
	throw new Error("use --run to generate notification assets");
const output = resolve("web/src/domains/settings/sounds");
const evidence = resolve("verification-reports/notification-sounds");
mkdirSync(output, { recursive: true });
mkdirSync(evidence, { recursive: true });
const saved = liveLarmSettings();
const gateway = createLarmPlayground({
	...saved,
	baseUrl: saved.baseUrl ?? undefined,
	voice: saved.voice ?? undefined,
	token: resolveLarmToken(process.env),
});
const target = findServiceTarget(
	(await gateway.catalog(AbortSignal.timeout(30000))).targets,
	"media.music.generate",
	"larm.music-generation.v1",
);
if (!target?.description) throw new Error("music_service_unavailable");
console.log(
	JSON.stringify({
		event: "service_discovered",
		endpoint: target.endpoint,
		description: target.description,
	}),
);
const motifs = [
	[
		"soft-chime",
		"Two soft rounded bell notes ascending, a warm delicate completion chime",
	],
	[
		"wooden-notes",
		"Two dry mellow wooden xylophone notes, gently rising, natural woody resonance",
	],
	[
		"glass-bell",
		"A single delicate glass bell strike with a short clean shimmering decay",
	],
	[
		"water-drop",
		"Two small clear water droplets plopping into a quiet pool, soft rounded liquid tone",
	],
	[
		"warm-marimba",
		"A warm low marimba playing three gentle ascending notes with a short decay",
	],
	[
		"tiny-harp",
		"A tiny acoustic harp plucking a light ascending three note arpeggio",
	],
	[
		"felt-piano",
		"A soft felt piano playing a gentle two note major interval, warm and reassuring",
	],
	[
		"soft-sparkle",
		"A delicate soft magical sparkle of tiny bells, brief clean high twinkle",
	],
	[
		"bamboo",
		"Two hollow bamboo chime taps, mellow airy woody resonance, peaceful",
	],
	[
		"gentle-bloom",
		"A soft warm synth mallet chord blooming gently then fading, a friendly completion sound",
	],
] as const;
for (const [id, motif] of motifs) {
	const path = `${output}/${id}.wav`;
	if (existsSync(path)) {
		console.log(JSON.stringify({ id, status: "already_exists" }));
		continue;
	}
	const signal = AbortSignal.timeout(300000);
	const result = await gateway.execute(
		target,
		{
			text: `${motif}. A polished subtle desktop notification sound effect. Only one short isolated event, immediate gentle attack, fully fades to silence. No voice, no speech, no background music, no harsh beep, no alarm, no hiss.`,
			task: "sound-effect",
			durationSeconds: 1.5,
			outputFormat: "wav",
		},
		signal,
		async (progress) => {
			console.log(
				JSON.stringify({ id, phase: progress.phase, jobId: progress.jobId }),
			);
		},
	);
	signal.throwIfAborted();
	if (!result.bytes) throw new Error("audio_missing");
	const raw = `${evidence}/${id}-source.wav`;
	writeFileSync(raw, result.bytes);
	const normalized = Bun.spawnSync([
		"ffmpeg",
		"-v",
		"error",
		"-y",
		"-i",
		raw,
		"-af",
		"loudnorm=I=-22:TP=-3:LRA=7,afade=t=in:d=0.015,areverse,afade=t=in:d=0.12,areverse",
		"-ar",
		"24000",
		"-ac",
		"1",
		"-c:a",
		"pcm_s16le",
		path,
	]);
	if (normalized.exitCode !== 0) throw new Error("audio_normalization_failed");
	writeFileSync(
		`${evidence}/${id}.json`,
		JSON.stringify(
			{
				id,
				prompt: motif,
				artifactId: result.artifact?.id,
				actualModel: result.actualModel,
				runtime: result.runtime,
				requestedSeconds: 1.5,
				sourceBytes: result.bytes.length,
			},
			null,
			2,
		) + "\n",
	);
	console.log(JSON.stringify({ id, status: "completed" }));
}
