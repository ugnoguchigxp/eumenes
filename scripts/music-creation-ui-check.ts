import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect as baseExpect } from "@playwright/test";
import { harness } from "../api/application/toolchain.fixture";
import { musicFixture, musicTestPlan } from "../api/application/music.fixture";
import { createFixture } from "../tests/browser/fixture";
import { openFromLauncher } from "../tests/browser/artifact-launcher";
const expect = baseExpect.configure({ timeout: 20000 });
const out = resolve("verification-reports/music-creation-ui");
mkdirSync(out, { recursive: true });
const f = createFixture();
const webPort = await f.port();
const origin = `http://127.0.0.1:${webPort}`;
process.env.EUMENES_ORIGIN = origin;
const token = "fixture-token-for-toolchain-browser";
const audio = readFileSync(
	"spec/verification/music-opus-2026-10-11/track.opus",
);
const lyrics = "[Verse]\n朝の光が窓を照らす\n新しい一日が始まる";
const plan = {
	...musicTestPlan,
	title: "朝のオーケストラ",
	prompt: "Orchestral pop with soft clear female vocals and piano",
	instrumental: false,
	lyrics,
	language: "ja",
};
const fast = musicFixture("success", { plan });
const slow = musicFixture("cancel", { plan });
let hold = false;
const h = await harness({
	model: fast.model,
	musicGateway: () => (hold ? slow.gateway() : fast.gateway()),
});
const requests: { path: string; method: string; body?: unknown }[] = [];
const savedTracks = [1, 2].map((n) => ({
	id: `saved-${n}`,
	title: `保存曲${n}`,
	prompt: "piano",
	tags: [],
	favorite: false,
	instrumental: true,
	model: "saved-recording",
	audioUrl: `/api/music/tracks/saved-${n}/audio`,
	metadataUrl: `/api/music/tracks/saved-${n}/metadata`,
	format: "opus",
	durationSeconds: 30,
	createdAt: "2026-10-12T00:00:00Z",
}));
const savedPlaylists = [1, 2].map((n) => ({
	kind: "playlist",
	id: `00000000-0000-4000-8000-00000000000${n}`,
	runId: `saved-${n}`,
	conversationId: "main",
	title: `保存した選曲${n}`,
	state: "completed",
	query: {
		q: n === 2 ? "ピアノ" : "",
		tags: [],
		sort: "createdAt",
		order: "desc",
		limit: 50,
	},
	trackIds: [`saved-${n}`],
	currentId: `saved-${n}`,
	errorCode: null,
	createdAt: n,
	updatedAt: n,
}));
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	idleTimeout: 60,
	fetch: async (request) => {
		const path = new URL(request.url).pathname;
		requests.push({
			path,
			method: request.method,
			body:
				request.method === "POST" ? await request.clone().json() : undefined,
		});
		if (request.headers.get("authorization") === `Bearer ${token}`) {
			if (path === "/api/music/playlists") return Response.json(savedPlaylists);
			if (
				path.startsWith("/api/music/playlists/") &&
				request.method === "PUT"
			) {
				const saved = savedPlaylists.find((p) => path.endsWith(p.id));
				if (!saved) return new Response(null, { status: 404 });
				Object.assign(saved, await request.json(), { updatedAt: Date.now() });
				return Response.json(saved);
			}
			if (path === "/api/music/tags") return Response.json({ tags: [] });
			if (path === "/api/music/tracks")
				return Response.json({ tracks: savedTracks, total: 2 });
			if (path.startsWith("/api/music/tracks/") && !path.endsWith("/audio")) {
				const saved = savedTracks.find((t) => path.endsWith(t.id));
				return saved
					? Response.json(saved)
					: new Response(null, { status: 404 });
			}
		}
		if (
			path.startsWith("/api/music/") &&
			path.endsWith("/audio") &&
			request.headers.get("authorization") === `Bearer ${token}`
		)
			return new Response(audio, { headers: { "Content-Type": "audio/ogg" } });
		return h.app.fetch(request);
	},
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
	await f.launchWeb({
		webPort,
		apiPort: server.port!,
		token,
		cacheDir: `/tmp/eumenes-music-creation-${webPort}`,
	});
	await f.ready(origin);
	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({
		viewport: { width: 1840, height: 1100 },
		colorScheme: "dark",
	});
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(origin);
	await page
		.getByRole("button", { name: "アーティファクトを開く", exact: true })
		.click();
	await expect(
		page.getByRole("menuitem", { name: "楽曲生成", exact: true }),
	).toHaveCount(1);
	await expect(
		page.getByRole("menuitem", { name: "音楽プレイリスト", exact: true }),
	).toHaveCount(1);
	await expect(
		page.getByRole("menuitem", { name: /^音楽:|^プレイリスト:/ }),
	).toHaveCount(0);
	await page.screenshot({ path: `${out}/launcher.png`, fullPage: true });
	await page.getByRole("menuitem", { name: "楽曲生成", exact: true }).click();
	const splitter = page.getByRole("separator", {
		name: "会話とアーティファクトのサイズを調整",
	});
	await splitter.focus();
	await page.keyboard.press("Home");
	const workspace = page.getByRole("region", {
		name: "音楽ワークスペース",
		exact: true,
	});
	const prompt = page.getByRole("textbox", { name: "音楽作成プロンプト" });
	await expect(
		page.getByRole("button", { name: "イメージを作成", exact: true }),
	).toBeDisabled();
	await expect(
		page.getByRole("img", { name: "楽曲イメージのモック" }),
	).toBeVisible();
	// Basic choices must fit the initial viewport, even with all 60 genres open.
	const basicChoicesVisible = async () => {
		const area = await page.locator(".music-creation-scroll").boundingBox();
		const targets = [
			page.getByRole("combobox", { name: "テンポ", exact: true }),
			page.getByRole("combobox", { name: "長さ", exact: true }),
			page.getByRole("group", { name: "雰囲気", exact: true }),
			page.getByRole("group", { name: "楽器", exact: true }),
		];
		if (!area) return false;
		for (const target of targets) {
			const box = await target.boundingBox();
			if (!box || box.y < area.y || box.y + box.height > area.y + area.height)
				return false;
		}
		return true;
	};
	await expect.poll(basicChoicesVisible).toBe(true);
	await page
		.getByRole("combobox", { name: "テンポ", exact: true })
		.selectOption("ゆったり");
	await page
		.getByRole("group", { name: "雰囲気", exact: true })
		.getByRole("checkbox", { name: "落ち着いた", exact: true })
		.check();
	await expect(prompt).toHaveValue(/テンポ：ゆったり/);
	await expect(prompt).toHaveValue(/雰囲気：落ち着いた/);
	await page.screenshot({ path: `${out}/overview.png`, fullPage: true });
	await page
		.getByRole("textbox", { name: "ジャンルを探す" })
		.fill("オーケストラ");
	await page
		.getByRole("checkbox", { name: "オーケストラ", exact: true })
		.check();
	await expect(prompt).toHaveValue(/ジャンル：オーケストラ/);
	await page.getByRole("textbox", { name: "ジャンルを探す" }).fill("");
	await page.getByRole("checkbox", { name: "歌声を入れる" }).check();
	await page
		.getByRole("combobox", { name: "ボーカル", exact: true })
		.selectOption("女性ボーカル");
	await page
		.getByRole("group", { name: "声質", exact: true })
		.getByRole("checkbox", { name: "柔らかい", exact: true })
		.check();
	await page.getByRole("textbox", { name: "歌詞（任意）" }).fill(lyrics);
	await expect(prompt).toHaveValue(/女性ボーカル/);
	expect(await prompt.inputValue()).toContain(lyrics);
	await page.screenshot({ path: `${out}/desktop.png`, fullPage: true });
	await page.locator(".music-creation-scroll").evaluate((node) => {
		node.scrollTop = 0;
	});
	await page.screenshot({ path: `${out}/genres.png`, fullPage: true });
	const written =
		(await prompt.inputValue()) + "\n自由記述：静かな朝の曲にしたい。";
	await prompt.fill(written);
	await page.getByRole("checkbox", { name: "Ambient", exact: true }).check();
	await expect(prompt).toHaveValue(written);
	await expect(
		page.getByRole("button", { name: "楽曲を生成", exact: true }),
	).toBeDisabled();
	await page
		.getByRole("button", { name: "編集内容を使う", exact: true })
		.click();
	hold = true;
	await page.getByRole("button", { name: "楽曲を生成", exact: true }).click();
	await expect(prompt).toHaveValue(written);
	await expect(
		page.getByRole("button", { name: "生成を取り消す", exact: true }),
	).toBeVisible();
	await page.screenshot({ path: `${out}/generating.png`, fullPage: true });
	await page
		.getByRole("button", { name: "生成を取り消す", exact: true })
		.click();
	await expect(
		page.getByText("楽曲の制作を取り消しました", { exact: true }),
	).toBeVisible();
	expect(
		requests.filter(
			(request) => request.path === "/api/runs" && request.method === "POST",
		),
	).toHaveLength(1);
	expect(
		requests.find(
			(request) => request.path === "/api/runs" && request.method === "POST",
		)?.body,
	).toMatchObject({ text: expect.stringContaining(written) });
	expect(requests.some((request) => request.path.endsWith("/cancel"))).toBe(
		true,
	);
	hold = false;
	await page.getByRole("button", { name: "楽曲を生成", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "再生", exact: true }),
	).toBeEnabled();
	await expect(
		page.getByRole("tab", { name: "楽曲生成", exact: true }),
	).toHaveCount(1);
	await expect(prompt).toHaveValue(written);
	await page.getByRole("button", { name: "Visualizer", exact: true }).click();
	await page.getByRole("button", { name: "再生", exact: true }).click();
	await expect
		.poll(() =>
			page
				.locator("audio")
				.evaluate((element: HTMLAudioElement) => element.currentTime),
		)
		.toBeGreaterThan(0.3);
	await page.getByRole("button", { name: "一時停止", exact: true }).click();
	await page.getByRole("button", { name: "生成履歴", exact: true }).click();
	await expect(
		workspace.getByRole("region", { name: "楽曲生成", exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "この曲のプロンプトを使う", exact: true })
		.click();
	await expect(prompt).toHaveValue(plan.prompt);
	await openFromLauncher(page, "音楽プレイリスト");
	await expect(
		page.getByRole("tab", { name: "楽曲生成", exact: true }),
	).toHaveCount(1);
	await expect(
		page.getByRole("tab", { name: "音楽プレイリスト", exact: true }),
	).toHaveCount(1);
	await expect(
		page.getByRole("combobox", { name: "保存したプレイリスト", exact: true }),
	).toHaveValue(savedPlaylists[1]!.id);
	await expect(
		page.getByRole("textbox", { name: "検索", exact: true }),
	).toHaveValue("ピアノ");
	await page
		.getByRole("combobox", { name: "保存したプレイリスト", exact: true })
		.selectOption(savedPlaylists[0]!.id);
	await expect(
		page.getByRole("textbox", { name: "検索", exact: true }),
	).toHaveValue("");
	await expect(
		page.getByRole("region", { name: "音楽プレイヤー" }).locator("audio"),
	).toHaveAttribute("src", "/api/music/tracks/saved-1/audio");
	await page.screenshot({ path: `${out}/playlist.png`, fullPage: true });
	await openFromLauncher(page, "楽曲生成");
	await expect(
		page.getByRole("tab", { name: "楽曲生成", exact: true }),
	).toHaveCount(1);
	await page.setViewportSize({ width: 390, height: 844 });
	await splitter.focus();
	await page.keyboard.press("Home");
	await page
		.getByRole("button", { name: "楽曲を生成", exact: true })
		.scrollIntoViewIfNeeded();
	await expect(
		page.getByRole("button", { name: "楽曲を生成", exact: true }),
	).toBeVisible();
	const fitsViewport = await page.evaluate(
		() => document.documentElement.scrollWidth <= window.innerWidth,
	);
	expect(fitsViewport, "music screen fits the narrow viewport").toBe(true);
	await page.screenshot({ path: `${out}/narrow.png`, fullPage: true });
	const imageMutationRequests = requests
		.filter(
			(request) =>
				request.path.includes("/images/") && request.method !== "GET",
		)
		.map((request) => `${request.method} ${request.path}`);
	const providerImageRequests = [...fast.requests, ...slow.requests].filter(
		(request) => request.path.includes("/images/"),
	).length;
	expect(
		imageMutationRequests,
		"the image mock makes no image creation request",
	).toHaveLength(0);
	expect(
		providerImageRequests,
		"the image mock makes no provider image request",
	).toBe(0);
	expect(errors).toEqual([]);
	writeFileSync(
		`${out}/result.json`,
		JSON.stringify(
			{
				requests,
				errors,
				fixture: true,
				liveGeneration: false,
				imageGeneration: false,
			},
			null,
			2,
		),
	);
} finally {
	await browser?.close();
	server.stop(true);
	await f.stopAll();
	await h.close();
}
