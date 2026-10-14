import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { chromium, expect as baseExpect } from "@playwright/test";
import { musicFixture } from "../api/application/music.fixture";
import { harness } from "../api/application/toolchain.fixture";
import { createFixture } from "../tests/browser/fixture";
import { openFromLauncher } from "../tests/browser/artifact-launcher";
const expect = baseExpect.configure({ timeout: 20000 });

// Replay saved audio; library mutations below affect only in-memory fixture data.
// No LLM, generation service, or production storage is used.
const audioIndex = process.argv.indexOf("--audio");
const audioPath =
	audioIndex >= 0
		? process.argv[audioIndex + 1]
		: "spec/verification/music-2026-10-11/track.mp3";
if (!audioPath) throw new Error("audio_path_required");
const mime = extname(audioPath) === ".opus" ? "audio/ogg" : "audio/mpeg";
const out = resolve(
	mime === "audio/ogg"
		? "verification-reports/music-openui-opus"
		: "verification-reports/music-openui",
);
mkdirSync(out, { recursive: true });
const bytes = readFileSync(audioPath);
const token = "fixture-token-for-toolchain-browser";
const f = createFixture();
const webPort = await f.port();
const origin = `http://127.0.0.1:${webPort}`;
process.env.EUMENES_ORIGIN = origin;
const music = musicFixture();
const h = await harness({
	model: {
		...music.model,
		answer: async () => {
			throw new Error("LLM must not run");
		},
	},
	musicGateway: music.gateway,
});
let phase: "generating" | "completed" = "generating";
let libraryMode = false;
const libraryTracks = Array.from({ length: 12 }, (_, i) => ({
	id: `saved-${i + 1}`,
	title: i === 0 ? "8-Bit Tetris Rush" : `保存曲 ${i + 1}`,
	prompt: "詳細モーダルだけに表示する説明",
	tags: ["電子音楽"],
	instrumental: true,
	model: "saved-recording",
	format: mime === "audio/ogg" ? "opus" : "mp3",
	durationSeconds: 30,
	createdAt: new Date(i * 1000).toISOString(),
	favorite: false,
	audioUrl: `/api/music/tracks/saved-${i + 1}/audio`,
	metadataUrl: `/api/music/tracks/saved-${i + 1}/metadata`,
}));
const playlist = {
	kind: "playlist",
	id: "11111111-1111-4111-8111-111111111111",
	runId: "fixture-library",
	conversationId: "main",
	state: "completed",
	title: "音楽ライブラリ",
	query: { q: "", tags: [], sort: "createdAt", order: "desc", limit: 50 },
	trackIds: libraryTracks.map((t) => t.id),
	currentId: libraryTracks[0]!.id,
	errorCode: null,
	createdAt: 1,
	updatedAt: 1,
};
const requests: { method: string; path: string }[] = [];
const record = (id: string, title: string) => ({
	id,
	title,
	conversationId: "main",
	runId: id,
	state: phase,
	description: "保存済みの30秒音声。再生成なし。",
	durationSeconds: 30,
	mime,
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
	idleTimeout: 60,
	fetch: async (request) => {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/api/music")) return h.app.fetch(request);
		requests.push({ method: request.method, path: url.pathname });
		if (request.headers.get("authorization") !== `Bearer ${token}`)
			return new Response("unauthorized", { status: 401 });
		if (url.pathname === "/api/music/playlists")
			return Response.json(libraryMode ? [playlist] : []);
		if (libraryMode && url.pathname.startsWith("/api/music/playlists/")) {
			if (request.method === "PUT")
				Object.assign(playlist, await request.json(), {
					updatedAt: playlist.updatedAt + 1,
				});
			return Response.json(playlist);
		}
		if (libraryMode && url.pathname === "/api/music/tags")
			return Response.json({
				tags: [{ tag: "電子音楽", count: libraryTracks.length }],
			});
		if (libraryMode && url.pathname === "/api/music/tracks")
			return Response.json({
				tracks: libraryTracks,
				total: libraryTracks.length,
			});
		if (libraryMode && url.pathname.startsWith("/api/music/tracks/")) {
			const track = libraryTracks.find(
				(t) => t.id === url.pathname.split("/")[4],
			);
			if (!track) return new Response(null, { status: 404 });
			if (
				url.pathname.endsWith("/favorite") &&
				["PUT", "DELETE"].includes(request.method)
			) {
				track.favorite = request.method === "PUT";
				return new Response(null, { status: 204 });
			}
			if (!url.pathname.endsWith("/audio")) return Response.json(track);
		}
		if (request.method !== "GET")
			throw new Error("Unexpected fixture mutation");
		if (url.pathname.endsWith("/audio"))
			return new Response(bytes, { headers: { "Content-Type": mime } });
		return Response.json(
			libraryMode
				? []
				: [
						record("saved-a", "8-Bit Tetris Rush"),
						record("saved-b", "保存済み音声・選曲試験用コピー"),
					],
		);
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
	await page.addInitScript(() => {
		Object.defineProperty(window, "WebGL2RenderingContext", {
			value: undefined,
		});
		const stats = { reads: 0, peak: 0, waveReads: 0, closed: 0 };
		Object.assign(window, { musicAnalysis: stats });
		const create = AudioContext.prototype.createAnalyser;
		AudioContext.prototype.createAnalyser = function () {
			const node = create.call(this);
			const frequency = node.getByteFrequencyData.bind(node);
			node.getByteFrequencyData = (data) => {
				frequency(data);
				stats.reads++;
				stats.peak = Math.max(stats.peak, ...data);
			};
			const waveform = node.getByteTimeDomainData.bind(node);
			node.getByteTimeDomainData = (data) => {
				waveform(data);
				stats.waveReads++;
			};
			return node;
		};
		const close = AudioContext.prototype.close;
		AudioContext.prototype.close = function () {
			stats.closed++;
			return close.call(this);
		};
	});
	await page.goto(origin);
	await openFromLauncher(page, "楽曲生成");
	await expect(
		page.getByText("楽曲を生成しています", { exact: true }),
	).toBeVisible();
	await page.screenshot({ path: `${out}/generating.png`, fullPage: true });
	phase = "completed";
	await page.reload();
	await openFromLauncher(page, "楽曲生成");
	const player = page.locator("audio");
	await expect(player).toHaveCount(1);
	await expect(page.getByRole("slider", { name: "再生位置" })).toBeEnabled();
	await page.getByRole("button", { name: "Visualizer", exact: true }).click();
	await page.getByRole("button", { name: "再生", exact: true }).click();
	await expect
		.poll(() => player.evaluate((n: HTMLAudioElement) => n.currentTime))
		.toBeGreaterThan(0.3);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as unknown as { musicAnalysis: { peak: number } })
						.musicAnalysis.peak,
			),
		)
		.toBeGreaterThan(0);
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
		page
			.getByRole("region", { name: "楽曲の表示", exact: true })
			.getByRole("heading", { name: "保存済み音声・選曲試験用コピー" }),
	).toBeVisible();
	await page.getByRole("button", { name: "前の楽曲" }).click();
	await expect(
		page
			.getByRole("region", { name: "楽曲の表示", exact: true })
			.getByRole("heading", { name: "8-Bit Tetris Rush" }),
	).toBeVisible();
	await page.getByRole("button", { name: "生成履歴", exact: true }).click();
	await page
		.getByRole("region", { name: "楽曲生成", exact: true })
		.getByRole("button", { name: /保存済み音声・選曲試験用コピー.*0:30/ })
		.click();
	await expect(
		page
			.getByRole("region", { name: "楽曲の表示", exact: true })
			.getByRole("heading", { name: "保存済み音声・選曲試験用コピー" }),
	).toBeVisible();
	await expect(page.getByRole("slider", { name: "再生位置" })).toBeEnabled();
	const media = await player.evaluate((n: HTMLAudioElement) => ({
		duration: n.duration,
		paused: n.paused,
		readyState: n.readyState,
	}));
	await page.getByRole("button", { name: "詳細", exact: true }).click();
	await expect(page.getByRole("link", { name: "楽曲を保存" })).toHaveAttribute(
		"href",
		/^blob:/,
	);
	await expect(page.getByRole("link", { name: "楽曲を保存" })).toHaveAttribute(
		"download",
		mime === "audio/ogg" ? /\.opus$/ : /\.mp3$/,
	);
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "楽曲イメージ", exact: true }).click();
	await expect(
		page.getByRole("img", { name: "楽曲イメージのモック" }),
	).toBeVisible();
	await page.getByRole("button", { name: "Visualizer", exact: true }).click();
	await page.screenshot({ path: `${out}/completed.png`, fullPage: true });
	libraryMode = true;
	await page.reload();
	await openFromLauncher(page, "音楽プレイリスト");
	const workspace = page.getByRole("region", {
		name: "音楽ワークスペース",
		exact: true,
	});
	const visual = workspace.getByRole("region", {
		name: "楽曲の表示",
		exact: true,
	});
	const star = visual.getByRole("button", {
		name: /8-Bit Tetris Rushをお気に入り/,
	});
	await expect(star).toHaveAttribute("aria-pressed", "false");
	await star.click();
	await expect(star).toHaveAttribute("aria-pressed", "true");
	await page.reload();
	await openFromLauncher(page, "音楽プレイリスト");
	await expect(star).toHaveAttribute("aria-pressed", "true");
	await star.click();
	await expect(star).toHaveAttribute("aria-pressed", "false");
	await expect(workspace.locator(".music-playlist-row")).toHaveCount(8);
	await expect(
		workspace.getByText("詳細モーダルだけに表示する説明", { exact: true }),
	).toHaveCount(0);
	await workspace
		.getByRole("button", { name: "保存曲 2の詳細", exact: true })
		.click();
	const dialog = page.getByRole("dialog", { name: "楽曲の詳細" });
	await expect(
		dialog.getByText("詳細モーダルだけに表示する説明", { exact: true }),
	).toBeVisible();
	await expect(page.locator(".music-workspace-visual h3")).toHaveText(
		"8-Bit Tetris Rush",
	);
	await page.keyboard.press("Escape");
	await expect(
		workspace.getByRole("button", { name: "保存曲 2の詳細", exact: true }),
	).toBeFocused();
	await workspace.getByRole("button", { name: "次へ", exact: true }).click();
	await expect(workspace.locator(".music-playlist-row")).toHaveCount(4);
	await workspace.getByRole("button", { name: "前へ", exact: true }).click();
	await workspace.getByRole("button", { name: "再生", exact: true }).click();
	await expect
		.poll(() => player.evaluate((n: HTMLAudioElement) => n.currentTime))
		.toBeGreaterThan(0.3);
	const sameAudio = await player.elementHandle();
	await visual
		.getByRole("button", { name: "楽曲イメージ", exact: true })
		.click();
	await expect(
		visual.getByText("この楽曲のイメージは未登録です。"),
	).toBeVisible();
	expect(
		await sameAudio!.evaluate(
			(node) => node === document.querySelector("audio"),
		),
	).toBe(true);
	await expect
		.poll(() => player.evaluate((n: HTMLAudioElement) => n.currentTime))
		.toBeGreaterThan(0.6);
	await visual.getByRole("button", { name: "Visualizer", exact: true }).click();
	await visual
		.getByRole("combobox", { name: "Visualizerの表示" })
		.selectOption("waveform");
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as unknown as { musicAnalysis: { waveReads: number } })
						.musicAnalysis.waveReads,
			),
		)
		.toBeGreaterThan(0);
	await workspace.getByRole("button", { name: "次の楽曲" }).click();
	await expect(
		visual.getByRole("heading", { name: "保存曲 2", exact: true }),
	).toBeVisible();
	await workspace.getByRole("button", { name: "前の楽曲" }).click();
	await expect(
		visual.getByRole("heading", { name: "8-Bit Tetris Rush", exact: true }),
	).toBeVisible();
	await expect
		.poll(() =>
			player.evaluate(
				(n: HTMLAudioElement) => !n.paused && n.currentTime > 0.3,
			),
		)
		.toBe(true);
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as unknown as { musicAnalysis: { closed: number } })
						.musicAnalysis.closed,
			),
		)
		.toBeGreaterThan(0);
	await page.setViewportSize({ width: 1280, height: 800 });
	expect(
		await workspace.evaluate((el) => {
			const left = el
				.querySelector(".music-workspace-visual")!
				.getBoundingClientRect();
			const right = el
				.querySelector(".music-workspace-library")!
				.getBoundingClientRect();
			return right.x >= left.right;
		}),
	).toBe(true);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page
		.getByRole("separator", { name: "会話とアーティファクトのサイズを調整" })
		.focus();
	await page.keyboard.press("Home");
	const geometry = await workspace.evaluate((el) => {
		const left = el
			.querySelector(".music-workspace-visual")!
			.getBoundingClientRect();
		const right = el
			.querySelector(".music-workspace-library")!
			.getBoundingClientRect();
		const panel = el.closest(".artifact-panel-body")!;
		const canvas = el.querySelector("canvas")!.getBoundingClientRect();
		const stage = el
			.querySelector(".music-workspace-stage")!
			.getBoundingClientRect();
		const current = el
			.querySelector(".music-workspace-current")!
			.getBoundingClientRect();
		return {
			visualizerContained:
				canvas.height > 0 &&
				canvas.bottom <= stage.bottom + 1 &&
				stage.bottom <= current.top + 1,
			sideBySide: right.x >= left.right,
			noVerticalScroll: panel.scrollHeight <= panel.clientHeight + 1,
			noHorizontalScroll: el.scrollWidth <= el.clientWidth,
			bottom: el.getBoundingClientRect().bottom,
			panelBottom: panel.getBoundingClientRect().bottom,
			parents: (() => {
				const result = [];
				for (
					let parent = el.parentElement;
					parent;
					parent = parent.parentElement
				) {
					result.push({
						tag: parent.tagName,
						class: parent.className,
						height: parent.clientHeight,
						display: getComputedStyle(parent).display,
					});
				}
				return result;
			})(),
			playerBottom: el.querySelector(".music-player")!.getBoundingClientRect()
				.bottom,
		};
	});
	writeFileSync(`${out}/geometry.json`, JSON.stringify(geometry, null, 2));
	expect(geometry.sideBySide).toBe(true);
	expect(geometry.noVerticalScroll).toBe(true);
	expect(geometry.noHorizontalScroll).toBe(true);
	expect(geometry.visualizerContained).toBe(true);
	// The workspace has a one-pixel outer border.
	expect(
		Math.abs(geometry.playerBottom - geometry.panelBottom),
	).toBeLessThanOrEqual(1);
	await workspace.screenshot({ path: `${out}/library-desktop.png` });
	await page.evaluate(() =>
		document.documentElement.setAttribute("data-theme", "dark"),
	);
	await workspace.screenshot({ path: `${out}/library-desktop-dark.png` });
	const analysis = await page.evaluate(
		() =>
			(
				window as unknown as {
					musicAnalysis: {
						reads: number;
						peak: number;
						waveReads: number;
						closed: number;
					};
				}
			).musicAnalysis,
	);
	await page.setViewportSize({ width: 1440, height: 480 });
	await workspace.locator(".music-workspace-body").evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	await expect(
		workspace.getByRole("region", { name: "音楽プレイヤー", exact: true }),
	).toBeInViewport({ ratio: 1 });
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.setViewportSize({ width: 390, height: 844 });
	expect(
		await workspace.evaluate((el) => el.scrollWidth <= el.clientWidth),
	).toBe(true);
	await visual.getByRole("button", { name: "詳細", exact: true }).click();
	await expect(dialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(
		workspace.getByRole("region", { name: "音楽プレイヤー", exact: true }),
	).toBeInViewport({ ratio: 1 });
	await workspace.screenshot({ path: `${out}/library-narrow.png` });
	expect(requests).toContainEqual({
		method: "PUT",
		path: "/api/music/tracks/saved-1/favorite",
	});
	expect(requests).toContainEqual({
		method: "DELETE",
		path: "/api/music/tracks/saved-1/favorite",
	});
	await expect(errors).toEqual([]);
	writeFileSync(
		`${out}/result.json`,
		JSON.stringify(
			{
				result: "passed",
				input: audioPath,
				mime,
				secondTrack: "same saved audio, fixture metadata copy",
				media,
				geometry,
				analysis,
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
	writeFileSync(
		`${out}/failure-requests.json`,
		JSON.stringify(requests, null, 2),
	);
	throw error;
} finally {
	await browser?.close();
	await f.stopAll();
	await server.stop(true);
	await h.close();
}
