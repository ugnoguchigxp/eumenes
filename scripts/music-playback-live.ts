import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createLarmPlayground, type LarmPort } from "../api/domains/larm";
import { resolveLarmToken } from "../api/infrastructure/auth-config";
import { harness } from "../api/application/toolchain.fixture";
import { createFixture } from "../tests/browser/fixture";
import { createLiveLarm, liveLarmSettings } from "./live-larm";
if (!process.argv.includes("--run"))
	throw new Error("use --run for read-only live playback");
const out = resolve("verification-reports/music-playback-live");
mkdirSync(out, { recursive: true });
const events: unknown[] = [],
	requests: { path: string; range: string | null; status: number }[] = [];
const record = (value: unknown) => {
	events.push(value);
	writeFileSync(`${out}/events.json`, JSON.stringify(events, null, 2));
	console.log(JSON.stringify(value));
};
const settings = liveLarmSettings(),
	token = resolveLarmToken(process.env);
if (!settings.baseUrl) throw new Error("saved_larm_connection_unconfigured");
const gateway = () =>
	createLarmPlayground({
		...settings,
		baseUrl: settings.baseUrl!,
		token,
		fetch: (async (url, init = {}) => {
			if ((init.method ?? "GET") !== "GET")
				throw new Error("read_only_live_music");
			const r = await fetch(url, init);
			requests.push({
				path: new URL(String(url)).pathname,
				range: new Headers(init.headers).get("range"),
				status: r.status,
			});
			return r;
		}) as typeof fetch,
	});
const signal = AbortSignal.timeout(15000);
const openapi = await fetch(new URL("/openapi.json", settings.baseUrl!), {
	headers: { Authorization: `Bearer ${token}` },
	signal,
});
const schema = await openapi.json();
record({
	stage: "contract",
	status: openapi.status,
	tracks: !!schema.paths?.["/v1/music/tracks"],
	tags: !!schema.paths?.["/v1/music/tags"],
});
const library = gateway().library,
	first = await library.tracks({}, signal),
	tags = await library.tags(signal);
record({
	stage: "library",
	total: first.total,
	ids: first.tracks.map((t) => t.id),
	tags: tags.tags,
});
const tag = tags.tags[0]?.tag;
if (tag)
	record({
		stage: "tag-search",
		tag,
		total: (await library.tracks({ tags: [tag] }, signal)).total,
	});
for (const q of ["piano", "ピアノ", "bright", "明るい"])
	record({
		stage: "search",
		q,
		total: (await library.tracks({ q, sort: "relevance" }, signal)).total,
	});
const both = first.tracks[0]?.tags.slice(0, 2);
if (both?.length)
	record({
		stage: "and-search",
		tags: both,
		total: (await library.tracks({ tags: both }, signal)).total,
	});
const live = createLiveLarm();
function observe(options: Parameters<LarmPort["answer"]>[2]) {
	return options?.tools?.length
		? {
				...options,
				onToolCalls: (
					calls: Parameters<
						NonNullable<
							NonNullable<Parameters<LarmPort["answer"]>[2]>["onToolCalls"]
						>
					>[0],
				) => {
					record({
						stage: "routing",
						calls: calls.map((c) => ({ name: c.name, arguments: c.arguments })),
					});
					options.onToolCalls?.(calls);
				},
			}
		: options;
}
const liveModel: LarmPort = {
	...live,
	answer: (messages, signal, options) =>
		live.answer(messages, signal, observe(options)),
	...(live.answerStream
		? {
				answerStream: (messages, signal, delta, options) =>
					live.answerStream!(messages, signal, delta, observe(options)),
			}
		: {}),
};
const model: LarmPort = process.argv.includes("--fixture-planning")
	? {
			status: () => ({ state: "ready", capabilities: ["llm"] }),
			connect: async () => {},
			close: async () => {},
			transcribe: async () => "",
			speak: async () => new Uint8Array(),
			answer: async (messages, _signal, options) => {
				if (options?.tools?.length) {
					options.onToolCalls!([
						{
							id: "playback",
							name: "music_library",
							arguments: JSON.stringify({ request: "保存曲のライブラリ" }),
						},
					]);
					return "";
				}
				if (messages[0]?.content.includes("OUTPUT_SCHEMA="))
					return JSON.stringify({
						title: "保存曲ライブラリ",
						q: "",
						tags: [],
						favorite: null,
						sort: "createdAt",
						order: "desc",
					});
				return "保存曲のプレイリストを開きました。";
			},
		}
	: liveModel;
record({
	stage: "mode",
	planning: process.argv.includes("--fixture-planning") ? "fixture" : "live",
});
const f = createFixture(),
	webPort = await f.port(),
	origin = `http://127.0.0.1:${webPort}`;
process.env.EUMENES_ORIGIN = origin;
const h = await harness({ model, musicGateway: gateway });
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (r) => h.app.fetch(r),
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
	const submitted = await (
		await h.request("/api/runs", {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "LARMに保存してある楽曲を新しい順のライブラリで聴きたい。プレイリストを開いて。",
		})
	).json();
	const run = await h.dialogue.waitForTerminal(submitted.id, {
		timeoutMs: 90000,
	});
	const playlists = h.music!.playback.list("main");
	record({
		stage: "conversation",
		runId: submitted.id,
		status: run?.status,
		playlists,
		answer: h.dialogue.answerText(submitted.id),
	});
	if (run?.status !== "completed" || playlists[0]?.state !== "completed")
		throw new Error("live_playlist_not_completed");
	await f.launchWeb({
		webPort,
		apiPort: server.port!,
		token: "fixture-token-for-toolchain-browser",
		cacheDir: `/tmp/eumenes-playback-${webPort}`,
	});
	await f.waitUntil(async () => (await fetch(origin)).ok, {
		message: "web_not_ready",
	});
	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({
		viewport: { width: 1440, height: 1100 },
	});
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("response", (r) => {
		if (new URL(r.url()).pathname.startsWith("/api/music"))
			void (async () => {
				record({
					stage: "api-response",
					path: new URL(r.url()).pathname,
					status: r.status(),
					...(r.status() >= 400
						? { body: await r.text().catch(() => "") }
						: {}),
				});
			})();
	});
	page.on("requestfailed", (r) => {
		if (new URL(r.url()).pathname.startsWith("/api/music"))
			record({
				stage: "request-failed",
				path: new URL(r.url()).pathname,
				failure: r.failure(),
			});
	});
	await page.goto(origin);

	record({
		stage: "page-state",
		text: await page.locator("body").innerText(),
		errors,
	});
	await page.screenshot({ path: `${out}/before-play.png`, fullPage: true });
	const audio = page.locator("section[aria-label='音楽プレイヤー'] audio");
	await expect(audio).toHaveCount(1, { timeout: 15000 });
	await expect(page.getByRole("slider", { name: "再生位置" })).toBeEnabled({
		timeout: 15000,
	});
	await page.getByRole("button", { name: "再生", exact: true }).click();
	await page.waitForFunction(() => {
		const a = document.querySelector("audio");
		return !!a && a.currentTime > 0.3 && !a.paused;
	});
	await page.getByRole("button", { name: "一時停止", exact: true }).click();
	const seek = await audio.evaluate(
		(a) =>
			Math.floor(Math.min(15, (a as HTMLAudioElement).duration / 2) * 10) / 10,
	);
	await page.getByRole("slider", { name: "再生位置" }).fill(String(seek));
	await page.waitForFunction((target) => {
		const a = document.querySelector("audio");
		return !!a && a.currentTime >= target - 0.5;
	}, seek);
	record({
		stage: "browser-playback",
		media: await audio.evaluate((element) => {
			const a = element as HTMLAudioElement;
			return {
				time: a.currentTime,
				duration: a.duration,
				paused: a.paused,
				src: a.getAttribute("src"),
			};
		}),
		errors,
	});
	const range = await page.evaluate(async () => {
		const src = document.querySelector("audio")!.getAttribute("src")!;
		const r = await fetch(src, { headers: { Range: "bytes=64-127" } });
		return {
			status: r.status,
			contentRange: r.headers.get("Content-Range"),
			acceptRanges: r.headers.get("Accept-Ranges"),
			contentType: r.headers.get("Content-Type"),
			bytes: (await r.arrayBuffer()).byteLength,
		};
	});
	record({ stage: "browser-range", ...range });
	if (range.status !== 206 || range.bytes !== 64)
		throw new Error("browser_range_failed");
	await page.screenshot({ path: `${out}/player.png`, fullPage: true });
	if (errors.length) throw new Error("browser_error");
} catch (error) {
	record({
		stage: "failed",
		error: error instanceof Error ? error.message : "unknown",
	});
	throw error;
} finally {
	writeFileSync(`${out}/requests.json`, JSON.stringify(requests, null, 2));
	await browser?.close();
	server.stop(true);
	await f.stopAll();
	await h.close();
	await live.close();
}
