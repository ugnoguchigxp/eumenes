import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createLarmPlayground, findServiceTarget } from "../api/domains/larm";
import { resolveLarmToken } from "../api/infrastructure/auth-config";
import { liveLarmSettings } from "./live-larm";

const candidateAt = process.argv.indexOf("--candidate");
const candidateId = candidateAt < 0 ? undefined : process.argv[candidateAt + 1];
if (!process.argv.includes("--run") || !candidateId)
	throw new Error(
		"use --run --candidate <id> for one 5-second preview; production assets are never replaced",
	);
const output = resolve(
	"verification-reports/notification-sounds/candidates",
	new Date().toISOString().replaceAll(":", "-"),
);
const evidence = output;
mkdirSync(output, { recursive: true });
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
const selected = motifs.find(([id]) => id === candidateId);
if (!selected) throw new Error("unknown_notification_candidate");
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

const [id, motif] = selected;
const path = `${output}/${id}.wav`;
const signal = AbortSignal.timeout(300000);
const result = await gateway.execute(
	target,
	{
		text: `${motif}. A polished subtle desktop notification sound effect. Only one short isolated event, immediate gentle attack, fully fades to silence. No voice, no speech, no background music, no harsh beep, no alarm, no hiss.`,
		task: "sound-effect",
		durationSeconds: 5,
		quality: "balanced",
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
writeFileSync(path, result.bytes);
writeFileSync(
	`${evidence}/${id}.json`,
	JSON.stringify(
		{
			id,
			prompt: motif,
			artifactId: result.artifact?.id,
			actualModel: result.actualModel,
			runtime: result.runtime,
			requestedSeconds: 5,
			listeningStatus: "pending",
			sourceBytes: result.bytes.length,
		},
		null,
		2,
	) + "\n",
);
console.log(
	JSON.stringify({ id, status: "candidate_ready_for_listening", path }),
);
