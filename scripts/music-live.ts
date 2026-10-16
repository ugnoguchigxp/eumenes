import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { harness } from "../api/application/toolchain/toolchain.fixture";
import { createLarmPlayground, type LarmPort } from "../api/domains/larm";
import { createLiveLarm, liveLarmSettings } from "./live-larm";
import { resolveLarmToken } from "../api/infrastructure/auth-config";
import { createFixture } from "../tests/browser/fixture";
if (!process.argv.includes("--run"))
	throw new Error("use --run for one live generation; no automatic retry");
const out = resolve(
	"verification-reports/music",
	new Date().toISOString().replaceAll(":", "-"),
);
mkdirSync(out, { recursive: true });
const events: unknown[] = [];
function record(value: Record<string, unknown>) {
	const event = { at: new Date().toISOString(), ...value };
	events.push(event);
	writeFileSync(`${out}/events.json`, JSON.stringify(events, null, 2), {
		mode: 0o600,
	});
	console.log(JSON.stringify(event));
}
const question = "Tetrisをテーマにした30秒の楽曲を作って";
const live = createLiveLarm();
type Options = Parameters<LarmPort["answer"]>[2];
function observe(options: Options): Options {
	return options?.tools?.length
		? {
				...options,
				onToolCalls: (calls) => {
					record({
						stage: "routing",
						calls: calls.map((c) => ({ name: c.name, arguments: c.arguments })),
					});
					options.onToolCalls?.(calls);
				},
			}
		: options;
}
function observeOutput(
	messages: Parameters<LarmPort["answer"]>[0],
	text: string,
) {
	if (messages[0]?.content.includes("OUTPUT_SCHEMA="))
		record({ stage: "music_plan", output: text });
	else if (text) record({ stage: "conversation_answer", text });
}
const model: LarmPort = {
	...live,
	answer: async (messages, signal, options) => {
		const value = await live.answer(messages, signal, observe(options));
		observeOutput(messages, value);
		return value;
	},
	...(live.answerStream
		? {
				answerStream: async (messages, signal, delta, options) => {
					const value = await live.answerStream!(
						messages,
						signal,
						delta,
						observe(options),
					);
					observeOutput(messages, value);
					return value;
				},
			}
		: {}),
};
const saved = liveLarmSettings();
async function removeTestTrack(jobId: string) {
	try {
		const path = `/v1/music/tracks/${encodeURIComponent(jobId)}`;
		const init = {
			headers: { Authorization: `Bearer ${resolveLarmToken(process.env)}` },
			redirect: "error" as const,
			signal: AbortSignal.timeout(15000),
		};
		const removed = await fetch(new URL(path, saved.baseUrl!), {
			...init,
			method: "DELETE",
		});
		if (removed.status !== 204)
			throw new Error(`music_cleanup_http_${removed.status}`);
		const absent = await fetch(new URL(path, saved.baseUrl!), init);
		await absent.body?.cancel();
		if (absent.status !== 404) throw new Error("music_cleanup_unconfirmed");
		record({
			stage: "test_track_removed",
			jobId,
			status: removed.status,
			confirmedStatus: absent.status,
		});
	} catch (error) {
		record({
			stage: "cleanup_failed",
			jobId,
			reason: error instanceof Error ? error.message : "unknown",
		});
		process.exitCode = 1;
	}
}
const gateway = () =>
	createLarmPlayground({
		...saved,
		baseUrl: saved.baseUrl ?? undefined,
		voice: saved.voice ?? undefined,
		token: resolveLarmToken(process.env),
		fetch: (async (url, init) => {
			const path = new URL(String(url)).pathname;
			if (path === "/v1/music/generations" && init?.method === "POST")
				record({
					stage: "generation_request",
					body: JSON.parse(String(init.body)),
				});
			const response = await fetch(url, init);
			if (path.startsWith("/v1/music/"))
				record({
					stage: "generation_http",
					method: init?.method ?? "GET",
					path,
					status: response.status,
				});
			return response;
		}) as typeof fetch,
	});
const fixture = createFixture();
const webPort = await fixture.port();
const origin = `http://127.0.0.1:${webPort}`;
process.env.EUMENES_ORIGIN = origin;
const h = await harness({ model, musicGateway: gateway });
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: h.app.fetch,
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let last = "";
const unsubscribe = h.store.onCommit(() => {
	const item = h.music!.list("main")[0];
	if (!item) return;
	const serialized = JSON.stringify(item);
	if (last === serialized) return;
	last = serialized;
	record({ stage: "music_state", ...item });
});
try {
	await fixture.launchWeb({
		webPort,
		apiPort: server.port!,
		token: "fixture-token-for-toolchain-browser",
		cacheDir: `/tmp/eumenes-music-vite-${webPort}`,
	});
	await fixture.waitUntil(async () => (await fetch(origin)).ok, {
		message: "music_web_not_ready",
	});
	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({
		viewport: { width: 1440, height: 1000 },
	});
	await page.goto(origin);
	record({ stage: "request", question });
	const response = await h.request("/api/runs", {
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: question,
	});
	if (!response.ok) throw new Error(`music_submit_http_${response.status}`);
	const submitted = await response.json();
	record({ stage: "accepted", runId: submitted.id });
	const run = await h.dialogue.waitForTerminal(submitted.id, {
		timeoutMs: 190000,
	});
	const music = h.music!.list("main")[0];
	record({
		stage: "final",
		run,
		answer: h.dialogue.answerText(submitted.id),
		music,
	});
	if (run?.status !== "completed" || music?.state !== "completed")
		throw new Error(music?.errorCode ?? run?.error ?? "music_not_completed");
	const audio = await h.request(`/api/music/${music.id}/audio`);
	if (!audio.ok) throw new Error("music_audio_unavailable");
	const filename = `${out}/track.${music.mime === "audio/ogg" ? "opus" : music.mime === "audio/mpeg" ? "mp3" : music.mime === "audio/flac" ? "flac" : "wav"}`;
	writeFileSync(filename, new Uint8Array(await audio.arrayBuffer()), {
		mode: 0o600,
	});
	const probe = Bun.spawnSync([
		"ffprobe",
		"-v",
		"error",
		"-show_entries",
		"format=duration:stream=codec_name,sample_rate,channels",
		"-of",
		"json",
		filename,
	]);
	if (probe.exitCode !== 0) throw new Error("music_audio_decode_failed");
	const media = JSON.parse(new TextDecoder().decode(probe.stdout));
	record({ stage: "audio_probe", ...media });
	if (
		music.mime !== "audio/ogg" ||
		media.streams[0]?.codec_name !== "opus" ||
		media.streams[0]?.sample_rate !== "48000"
	)
		throw new Error("music_opus_mismatch");
	if (Math.abs(Number(media.format.duration) - 30) > 1)
		throw new Error("music_duration_mismatch");
	const player = page.locator('section[aria-label="音楽プレイヤー"] audio');
	await player.waitFor({ state: "attached", timeout: 15000 });
	const played = await player.evaluate(async (node) => {
		const audio = node as HTMLAudioElement;
		await audio.play();
		await new Promise((r) => setTimeout(r, 1000));
		const result = {
			currentTime: audio.currentTime,
			duration: audio.duration,
			paused: audio.paused,
			readyState: audio.readyState,
			error: audio.error?.code ?? null,
		};
		audio.pause();
		return result;
	});
	record({ stage: "browser_playback", ...played });
	if (played.currentTime <= 0 || played.error || played.paused)
		throw new Error("music_browser_playback_failed");
	await page.screenshot({ path: `${out}/artifact.png`, fullPage: true });
	record({ stage: "passed", outputDirectory: out });
} catch (error) {
	record({
		stage: "failed",
		reason: error instanceof Error ? error.message : "unknown",
	});
	process.exitCode = 1;
} finally {
	unsubscribe();
	// This harness has a fresh isolated DB: only its newly completed test track is removed.
	const music = h.music!.list("main")[0];
	if (music?.state === "completed" && music.jobId)
		await removeTestTrack(music.jobId);
	await browser?.close();
	await fixture.stopAll();
	await server.stop(true);
	await h.close();
}
