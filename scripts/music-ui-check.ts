import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { musicFixture } from "../api/application/music.fixture";
import { harness } from "../api/application/toolchain.fixture";
import { createFixture } from "../tests/browser/fixture";

// Read-only replay of an already generated audio file. No LLM or generation service is used.
const out = resolve("verification-reports/music-openui");
mkdirSync(out, { recursive: true });
const bytes = readFileSync("spec/verification/music-2026-10-11/track.mp3");
const token = "fixture-token-for-toolchain-browser";
const f = createFixture();
const webPort = await f.port();
const origin = `http://127.0.0.1:${webPort}`;
process.env.EUMENES_ORIGIN = origin;
const h = await harness({
	model: {
		...musicFixture().model,
		answer: async () => {
			throw new Error("LLM must not run");
		},
	},
});
let phase: "generating" | "completed" = "generating";
const requests: { method: string; path: string }[] = [];
const record = (id: string, title: string) => ({
	id,
	title,
	conversationId: "main",
	runId: id,
	state: phase,
	description: "保存済みの30秒音声。再生成なし。",
	durationSeconds: 30,
	mime: "audio/mpeg",
	updatedAt: phase === "generating" ? 1 : 2,
	createdAt: 1,
	prompt: null,
	phase,
	jobId: null,
	errorCode: null,
	actualModel: "saved-recording",
});
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: async (request) => {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/api/music")) return h.app.fetch(request);
		requests.push({ method: request.method, path: url.pathname });
		if (request.headers.get("authorization") !== `Bearer ${token}`)
			return new Response("unauthorized", { status: 401 });
		if (request.method !== "GET") throw new Error("No music mutations allowed");
		if (url.pathname.endsWith("/audio"))
			return new Response(bytes, { headers: { "Content-Type": "audio/mpeg" } });
		return Response.json([
			record("saved-a", "8-Bit Tetris Rush"),
			record("saved-b", "保存済み音声・選曲試験用コピー"),
		]);
	},
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
	await f.launchWeb({
		webPort,
		apiPort: server.port!,
		token,
		cacheDir: `/tmp/eumenes-openui-${webPort}`,
	});
	await f.waitUntil(async () => (await fetch(origin)).ok, {
		message: "web_not_ready",
	});
	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({
		viewport: { width: 1440, height: 1000 },
	});
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto(origin);
	await expect(
		page.getByText("楽曲を生成しています", { exact: true }),
	).toBeVisible();
	await page.screenshot({ path: `${out}/generating.png`, fullPage: true });
	phase = "completed";
	await page.reload();
	const player = page.locator("audio");
	await expect(player).toHaveCount(1);
	await expect(page.getByRole("slider", { name: "再生位置" })).toBeEnabled();
	await page.getByRole("button", { name: "再生", exact: true }).click();
	await expect
		.poll(() => player.evaluate((n: HTMLAudioElement) => n.currentTime))
		.toBeGreaterThan(0.3);
	await page.getByRole("button", { name: "一時停止", exact: true }).click();
	const seek = page.getByRole("slider", { name: "再生位置" });
	await seek.focus();
	await page.keyboard.press("Home");
	await page.getByRole("button", { name: "10秒スキップ" }).click();
	await expect
		.poll(() => player.evaluate((n: HTMLAudioElement) => n.currentTime))
		.toBeCloseTo(10, 0);
	await page.getByRole("button", { name: "10秒巻き戻し" }).click();
	await expect
		.poll(() => player.evaluate((n: HTMLAudioElement) => n.currentTime))
		.toBe(0);
	await seek.focus();
	await page.keyboard.press("ArrowRight");
	await expect
		.poll(() => player.evaluate((n: HTMLAudioElement) => n.currentTime))
		.toBeGreaterThan(0);
	await page.getByRole("button", { name: "次の楽曲" }).click();
	await expect(
		page.getByRole("heading", { name: "保存済み音声・選曲試験用コピー" }),
	).toBeVisible();
	await page.getByRole("button", { name: "前の楽曲" }).click();
	await expect(
		page.getByRole("heading", { name: "8-Bit Tetris Rush" }),
	).toBeVisible();
	await page
		.getByRole("region", { name: "プレイリスト", exact: true })
		.getByRole("button", { name: /保存済み音声・選曲試験用コピー/ })
		.click();
	await expect(
		page.getByRole("heading", { name: "保存済み音声・選曲試験用コピー" }),
	).toBeVisible();
	await expect(page.getByRole("slider", { name: "再生位置" })).toBeEnabled();
	const media = await player.evaluate((n: HTMLAudioElement) => ({
		duration: n.duration,
		paused: n.paused,
		readyState: n.readyState,
	}));
	await expect(page.getByRole("link", { name: "楽曲を保存" })).toHaveAttribute(
		"href",
		/^blob:/,
	);
	await page.screenshot({ path: `${out}/completed.png`, fullPage: true });
	await expect(errors).toEqual([]);
	writeFileSync(
		`${out}/result.json`,
		JSON.stringify(
			{
				result: "passed",
				input: "saved track.mp3",
				secondTrack: "same saved audio, fixture metadata copy",
				media,
				requests,
				errors,
			},
			null,
			2,
		),
	);
	console.log(JSON.stringify({ result: "passed", media, out }));
} catch (error) {
	writeFileSync(`${out}/failure.txt`, String(error));
	throw error;
} finally {
	await browser?.close();
	await f.stopAll();
	await server.stop(true);
	await h.close();
}
