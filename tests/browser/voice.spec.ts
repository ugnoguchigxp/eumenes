import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { createFixture } from "./fixture";

const TOKEN = "fixture-api-token-0123456789abcdef";
const root = process.cwd();
const fixture = createFixture();
let dir: string;
let apiPort: number, webPort: number, larmPort: number;
// Node has no Sec-Fetch-Site, so the Vite dev proxy rightly refuses to authorize it:
// fixture-side API calls go straight to the backend with the explicit token.
const apiFetch = (input: string, init: RequestInit = {}) =>
	fetch(input.replace(`:${webPort}/`, `:${apiPort}/`), {
		...init,
		headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers },
	});
/** Waits for the page to present `count` animation frames, not for wall-clock time. */
const animationFrames = (page: Page, count: number) =>
	page.evaluate(
		(frames) =>
			new Promise<void>((resolve) => {
				const step = (left: number) =>
					left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
				step(frames);
			}),
		count,
	);
test.beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "eumenes-browser-"));
	({ apiPort, webPort, larmPort } = await fixture.startVoiceStack({
		dir,
		token: TOKEN,
	}));
});
// Preserve operational evidence before fixture teardown removes its temporary DB.
test.afterEach(async ({ page: _page }, testInfo) => {
	if (testInfo.status === testInfo.expectedStatus) return;
	const file = join(dir, "logs/api.jsonl");
	if (existsSync(file)) {
		const output = testInfo.outputPath("backend.jsonl");
		writeFileSync(output, readFileSync(file));
		await testInfo.attach("backend-log", {
			path: output,
			contentType: "application/x-ndjson",
		});
	}
});

test.afterAll(async () => {
	await fixture.stopAll();
	rmSync(dir, { recursive: true, force: true });
});
test.beforeEach(async ({ page }) => {
	// Business-flow tests exercise the supported WebGL fallback. The dedicated
	// rendering test creates its own browser with SwiftShader and checks pixels.
	// This avoids slow GPU initialization starving unrelated UI assertions.
	await page.addInitScript(() => {
		Object.defineProperty(window, "WebGL2RenderingContext", {
			value: undefined,
		});
	});
});
test.describe("light avatar rendering", () => {
	test("light avatar stays behind usable chat", async ({ playwright }) => {
		test.setTimeout(60000);
		const browser = await playwright.chromium.launch({
			args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
		});
		try {
			const context = await browser.newContext();
			const page = await context.newPage();
			const url = `http://127.0.0.1:${webPort}`;
			await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
			await page.setViewportSize({ width: 390, height: 844 });
			await page.goto(url);
			const canvas = page.locator(".light-avatar-background canvas");
			const avatar = page.locator(".light-avatar-background");
			// The three.js chunk is imported when the main thread is idle (up to ~1.5s), then
			// software GL builds the model: allow for both before the first canvas.
			await expect(avatar).toHaveAttribute("data-avatar-state", "ready", {
				timeout: 30000,
			});
			await expect(avatar).toHaveAttribute("data-avatar-motion", "static");
			await expect(canvas).toHaveCount(1, { timeout: 30000 });
			await expect(canvas).toBeVisible();
			expect(
				await canvas.evaluate((element) => {
					const canvas = element as HTMLCanvasElement;
					return canvas.getContext("webgl2")?.getContextAttributes()?.alpha;
				}),
			).toBe(true);
			await expect(page.locator(".chat-panel")).toHaveCSS(
				"background-color",
				"rgba(0, 0, 0, 0)",
			);
			const still = await canvas.screenshot();
			// Let the page present a run of animation frames: with reduced motion none may differ.
			await animationFrames(page, 15);
			expect((await canvas.screenshot()).equals(still)).toBe(true);
			const stillCanvas = await canvas.elementHandle();
			await page.emulateMedia({ reducedMotion: "no-preference" });
			// A motion preference change keeps the canvas: only the playback is switched.
			await expect(avatar).toHaveAttribute("data-avatar-motion", "animated");
			await expect(avatar).toHaveAttribute("data-avatar-state", "ready");
			expect(await stillCanvas!.evaluate((node) => node.isConnected)).toBe(
				true,
			);
			await expect(canvas).toHaveCount(1);
			const breathing = await canvas.screenshot();
			await expect
				.poll(async () => (await canvas.screenshot()).equals(breathing))
				.toBe(false);
			const movingCanvas = await canvas.elementHandle();
			await page.emulateMedia({ reducedMotion: "reduce" });
			await expect(avatar).toHaveAttribute("data-avatar-motion", "static");
			expect(await movingCanvas!.evaluate((node) => node.isConnected)).toBe(
				true,
			);
			await expect(canvas).toHaveCount(1);
			await animationFrames(page, 15);
			const paused = await canvas.screenshot();
			await animationFrames(page, 15);
			expect((await canvas.screenshot()).equals(paused)).toBe(true);
			// Hiding the tab pauses the playback without rebuilding the canvas.
			const setVisibility = (state: "hidden" | "visible") =>
				page.evaluate((next) => {
					Object.defineProperty(document, "visibilityState", {
						configurable: true,
						get: () => next,
					});
					document.dispatchEvent(new Event("visibilitychange"));
				}, state);
			await setVisibility("hidden");
			await expect(avatar).toHaveAttribute("data-avatar-state", "paused");
			expect(await movingCanvas!.evaluate((node) => node.isConnected)).toBe(
				true,
			);
			await expect(canvas).toHaveCount(1);
			await setVisibility("visible");
			await expect(avatar).toHaveAttribute("data-avatar-state", "ready");
			expect(await movingCanvas!.evaluate((node) => node.isConnected)).toBe(
				true,
			);
			await page
				.getByRole("textbox", { name: "メッセージ" })
				.fill("配置の確認");
			await expect(
				page.getByRole("button", { name: "送信", exact: true }),
			).toBeEnabled();
			const composer = await page.locator(".chat-composer").boundingBox();
			expect(composer).not.toBeNull();
			expect(composer!.y + composer!.height).toBeLessThanOrEqual(844);
			await expect(
				page.getByRole("textbox", { name: "メッセージ" }),
			).toHaveValue("配置の確認");
			const fallback = await context.newPage();
			try {
				await fallback.addInitScript(() => {
					Object.defineProperty(window, "WebGL2RenderingContext", {
						value: undefined,
					});
				});
				await fallback.goto(url);
				await fallback
					.getByRole("textbox", { name: "メッセージ" })
					.fill("描画なしでも入力");
				await expect(
					fallback.locator(".light-avatar-background canvas"),
				).toHaveCount(0);
				await expect(
					fallback.getByRole("button", { name: "送信", exact: true }),
				).toBeEnabled();
			} finally {
				await fallback.close();
			}
		} finally {
			await browser.close();
		}
	});
});
test("exported LARM token connects the UI and CLI without browser credentials", async ({
	page,
}) => {
	const browserAuthHeaders: Array<string | undefined> = [];
	page.on("request", (request) => {
		if (new URL(request.url()).pathname.startsWith("/api/"))
			browserAuthHeaders.push(request.headers().authorization);
	});
	const statusResponse = page.waitForResponse(
		(response) => new URL(response.url()).pathname === "/api/status",
	);
	await page.goto(`http://127.0.0.1:${webPort}/`);
	const response = await statusResponse;
	expect(response.status()).toBe(200);
	expect(await response.text()).not.toContain("fixture-control");
	await expect(page.getByRole("textbox", { name: "メッセージ" })).toBeVisible();
	await expect(page.locator('input[type="password"]')).toHaveCount(0);
	expect(browserAuthHeaders.length).toBeGreaterThan(0);
	expect(browserAuthHeaders.every((header) => header === undefined)).toBe(true);
	expect((await fetch(`http://127.0.0.1:${apiPort}/api/status`)).status).toBe(
		401,
	);
	const cli = spawnSync("bun", ["cli/index.ts", "status", "--json"], {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			EUMENES_URL: `http://127.0.0.1:${apiPort}`,
			EUMENES_API_TOKEN: TOKEN,
			LARM_API_TOKEN: "fixture-control",
			LARM_CONTROL_TOKEN: "",
		},
	});
	expect(cli.status, cli.stderr).toBe(0);
	expect(JSON.parse(cli.stdout)).toHaveProperty("larm");
});

test("a backend outage does not poll snapshots and explicit reconnect reloads the views", async ({
	page,
}) => {
	let unavailable = true;
	const counts = new Map<string, number>();
	await page.route(`http://127.0.0.1:${webPort}/api/**`, async (route) => {
		const path = new URL(route.request().url()).pathname;
		// Restore the fixture only after the user's reconnect action reaches the API.
		// Background SSE retries must not remove the button before Playwright clicks it.
		if (path === "/api/larm/connect" && route.request().method() === "POST")
			unavailable = false;
		counts.set(path, (counts.get(path) ?? 0) + 1);
		if (unavailable)
			await route.fulfill({
				status: 503,
				contentType: "application/json",
				body: JSON.stringify({ error: "unavailable" }),
			});
		else await route.continue();
	});
	// Page timers run on a clock the test advances, so "nothing is polled" is checked
	// against every timer that would fire in the window instead of a real sleep.
	await page.clock.install();
	await page.goto(`http://127.0.0.1:${webPort}/`);
	await expect(
		page.getByRole("button", { name: "接続を再確認" }),
	).toBeVisible();
	await expect
		.poll(() => counts.get("/api/conversations/main/runs") ?? 0)
		.toBeGreaterThan(0);
	await expect(
		page.getByText("会話履歴を取得できませんでした。"),
	).toBeVisible();
	// StrictMode can mount twice; compare after initial errors have settled.
	await page.clock.runFor(100);
	const watched = [
		"/api/conversations/main/runs",
		"/api/conversations/main",
		"/api/status",
	];
	const initial = watched.map((path) => counts.get(path));
	await page.clock.runFor(2000);
	expect(watched.map((path) => counts.get(path))).toEqual(initial);
	await page.getByRole("button", { name: "接続を再確認" }).click();
	await expect(page.locator(".connection-health .health-state")).toHaveText(
		"接続済み",
	);
	await expect(page.getByRole("button", { name: "接続を再確認" })).toHaveCount(
		0,
	);
	await expect
		.poll(() => counts.get("/api/conversations/main") ?? 0)
		.toBeGreaterThan(initial[1] ?? 0);
});
test("text and browser audio complete through real services with fixture provider", async ({
	page,
}) => {
	const browserAuthHeaders: Array<string | undefined> = [];
	page.on("request", (request) => {
		if (new URL(request.url()).pathname.startsWith("/api/"))
			browserAuthHeaders.push(request.headers().authorization);
	});
	// The API still requires auth; only the local dev proxy supplies it.
	expect((await fetch(`http://127.0.0.1:${apiPort}/api/status`)).status).toBe(
		401,
	);
	await page.addInitScript(() => {
		const media = navigator.mediaDevices;
		Object.defineProperty(media, "getUserMedia", {
			configurable: true,
			value: async () => {
				const context = new AudioContext();
				const output = context.createMediaStreamDestination();
				const speak = () => {
					const oscillator = context.createOscillator();
					const gain = context.createGain();
					gain.gain.value = 0.2;
					oscillator.connect(gain);
					gain.connect(output);
					oscillator.start();
					setTimeout(() => oscillator.stop(), 550);
				};
				Reflect.set(window, "triggerSpeech", speak);
				setTimeout(speak, 400);
				return output.stream;
			},
		});
	});
	await page.goto(`http://127.0.0.1:${webPort}/`);
	await expect(page.getByRole("textbox", { name: "メッセージ" })).toBeVisible();
	await expect(page.locator('input[type="password"]')).toHaveCount(0);
	await page
		.getByRole("textbox", { name: "メッセージ" })
		.fill("以前の話を覚えていますか");
	await page.getByRole("button", { name: "送信" }).click();
	await expect(
		page.getByText("承知しました。先ほどの話を覚えています。").first(),
	).toBeVisible();
	expect(browserAuthHeaders.length).toBeGreaterThan(0);
	expect(browserAuthHeaders.every((header) => header === undefined)).toBe(true);
	const requestId = crypto.randomUUID();
	const cli = (args: string[]) =>
		spawnSync("bun", ["cli/index.ts", ...args], {
			cwd: root,
			encoding: "utf8",
			env: {
				...process.env,
				EUMENES_URL: `http://127.0.0.1:${apiPort}`,
				EUMENES_API_TOKEN: TOKEN,
				LARM_API_TOKEN: "fixture-control",
				LARM_CONTROL_TOKEN: "",
			},
		});
	const sent = cli([
		"send",
		"CLIからの挨拶",
		"--wait",
		"--json",
		"--request-id",
		requestId,
	]);
	expect(sent.status, sent.stderr).toBe(0);
	const sentRun = JSON.parse(sent.stdout);
	expect(sentRun.status).toBe("completed");
	const replay = cli([
		"send",
		"CLIからの挨拶",
		"--json",
		"--request-id",
		requestId,
	]);
	expect(replay.status, replay.stderr).toBe(0);
	expect(JSON.parse(replay.stdout).id).toBe(sentRun.id);
	const history = cli(["history", "main", "--json"]);
	expect(history.status, history.stderr).toBe(0);
	expect(JSON.parse(history.stdout).messages).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ text: "CLIからの挨拶" }),
		]),
	);
	await expect(
		page.locator(".messages").getByText("CLIからの挨拶"),
	).toBeVisible();
	await page.getByRole("button", { name: "音声を開始" }).click();
	try {
		await expect(page.getByRole("textbox", { name: "メッセージ" })).toHaveValue(
			"こんにちは",
			{
				timeout: 20000,
			},
		);
	} catch (error) {
		console.error(await page.locator("body").innerText());
		throw error;
	}
	await expect(
		page.locator(".messages").getByText("こんにちは", { exact: true }).first(),
	).toBeVisible({ timeout: 20000 });
	await expect(page.getByText(/^(playing|再生済み)$/)).toBeVisible({
		timeout: 20000,
	});
	await page.evaluate(() =>
		(window as unknown as { triggerSpeech: () => void }).triggerSpeech(),
	);
	await expect(
		page.locator(".messages").getByText("こんにちは", { exact: true }),
	).toHaveCount(2, {
		timeout: 20000,
	});
	await expect(page.getByText("再生済み", { exact: true })).toBeVisible({
		timeout: 20000,
	});
	await page.getByRole("button", { name: "マイクを停止" }).click();
	await expect(page.getByRole("textbox", { name: "メッセージ" })).toHaveValue(
		"こんにちは",
	);
	await expect(
		page.getByRole("button", { name: "送信", exact: true }),
	).toBeEnabled();
	await expect(page.getByRole("button", { name: "音声を開始" })).toBeEnabled();
});

test("idle views keep one SSE stream without periodic snapshot requests", async ({
	page,
}) => {
	const counts = new Map<string, number>();
	let activeStreams = 0,
		maxStreams = 0;
	const pendingStreams = new Set<unknown>();
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (!url.pathname.startsWith("/api/")) return;
		counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1);
		if (url.pathname === "/api/events") {
			pendingStreams.add(request);
			activeStreams++;
			maxStreams = Math.max(maxStreams, activeStreams);
		}
	});
	const end = (request: unknown) => {
		if (pendingStreams.delete(request)) activeStreams--;
	};
	page.on("requestfinished", end);
	page.on("requestfailed", end);
	await page.clock.install();
	await page.goto(`http://127.0.0.1:${webPort}/`);
	await expect(page.locator(".connection-health .health-state")).toHaveText(
		/^(接続済み|待機中)$/,
		{ timeout: 15000 },
	);
	await expect.poll(() => counts.get("/api/events") ?? 0).toBeGreaterThan(0);
	await page.clock.runFor(600);
	// Development StrictMode remounts once; the settled page must share one stream.
	maxStreams = activeStreams;
	const before = Object.fromEntries(counts);
	await page.clock.runFor(6200);
	expect(Object.fromEntries(counts)).toEqual(before);
	expect(activeStreams).toBe(1);
	expect(maxStreams).toBe(1);
	await page.goto("about:blank");
	await expect.poll(() => activeStreams).toBe(0);
});

test("failed notifications are visible while API works; returning to the page restores missed answers", async ({
	page,
}) => {
	let notificationsUnavailable = true;
	// Keep a known old snapshot during the simulated outage. Initial query
	// completion or focus from another browser must not reveal the new run early.
	const snapshot = await (
		await apiFetch(`http://127.0.0.1:${webPort}/api/conversations/main`)
	).text();
	await page.route(
		`http://127.0.0.1:${webPort}/api/conversations/main`,
		async (route) => {
			if (notificationsUnavailable)
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: snapshot,
				});
			else await route.continue();
		},
	);
	await page.route(`http://127.0.0.1:${webPort}/api/events`, async (route) => {
		if (notificationsUnavailable)
			await route.fulfill({
				status: 404,
				contentType: "application/json",
				body: JSON.stringify({ error: "not_found" }),
			});
		else await route.continue();
	});
	await page.goto(`http://127.0.0.1:${webPort}/`);
	await expect(
		page.getByText(
			"更新情報に接続できません。文字起こしや回答の表示が遅れる場合があります。",
			{ exact: true },
		),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "接続を再確認", exact: true }),
	).toBeVisible();
	const prompt = "画面を戻した時の通知復旧を確認";
	const accepted = await apiFetch(`http://127.0.0.1:${webPort}/api/runs`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: prompt,
		}),
	});
	expect(accepted.status).toBe(202);
	const run = (await accepted.json()) as { id: string };
	await expect
		.poll(
			async () =>
				(
					(await (
						await apiFetch(`http://127.0.0.1:${webPort}/api/runs/${run.id}`)
					).json()) as { status: string }
				).status,
		)
		.toBe("completed");
	await expect(
		page.locator(".messages").getByText(prompt, { exact: true }),
	).toHaveCount(0);
	notificationsUnavailable = false;
	await page.evaluate(() => {
		window.dispatchEvent(new Event("focus"));
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await expect(
		page.locator(".messages").getByText(prompt, { exact: true }),
	).toBeVisible();
	await expect(
		page.getByText(
			"更新情報に接続できません。文字起こしや回答の表示が遅れる場合があります。",
			{ exact: true },
		),
	).toHaveCount(0);
});

test("partial ASR and text arrive early; speech waits for the completed answer", async ({
	page,
}) => {
	const control = (path: string) =>
		fetch(`http://127.0.0.1:${larmPort}/fixture/${path}`, {
			headers: { Authorization: "Bearer fixture-control" },
		});
	await control("hold-next");
	await page.addInitScript(() => {
		Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
			configurable: true,
			value: async () => {
				const context = new AudioContext(),
					output = context.createMediaStreamDestination();
				setTimeout(() => {
					const oscillator = context.createOscillator(),
						gain = context.createGain();
					gain.gain.value = 0.2;
					oscillator.connect(gain);
					gain.connect(output);
					oscillator.start();
					setTimeout(() => oscillator.stop(), 2600);
				}, 400);
				return output.stream;
			},
		});
	});
	try {
		await page.goto(`http://127.0.0.1:${webPort}/#conversation`);
		await page.getByRole("button", { name: "音声を開始" }).click();
		await expect(page.getByRole("textbox", { name: "メッセージ" })).toHaveValue(
			"こんにちは",
			{
				timeout: 10000,
			},
		);
		await expect(page.getByText("認識: こんにちは")).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "送信", exact: true }),
		).toBeDisabled();
		// Typing after a prefix takes ownership; final ASR must not overwrite that edit.
		await page
			.getByRole("textbox", { name: "メッセージ" })
			.fill("手入力の修正");
		// Prefix recognition is visible while the microphone has not finalized a run.
		await expect(page.locator('.message[aria-busy="true"]')).toHaveCount(0);
		const streaming = page.locator('.message-assistant[aria-busy="true"]');
		await expect(streaming).toContainText("承知しました。", { timeout: 10000 });
		await expect(streaming).not.toContainText("先ほどの話");
		const seen = await (await control("observations")).json();
		expect(seen.ttsInputs).toEqual([]);
		expect(seen.asrInputs.length).toBeGreaterThanOrEqual(2);
		expect(
			seen.asrInputs.every((a: { rate: number }) => a.rate === 16000),
		).toBe(true);
		await control("release");
		await expect(streaming).toHaveCount(0, { timeout: 10000 });
		await expect(page.getByText("再生済み", { exact: true })).toBeVisible({
			timeout: 10000,
		});
		await expect(page.getByRole("textbox", { name: "メッセージ" })).toHaveValue(
			"手入力の修正",
		);
		await expect(
			page.getByRole("button", { name: "送信", exact: true }),
		).toBeEnabled();
		const finished = await (await control("observations")).json();
		expect(finished.ttsInputs).toEqual([
			"承知しました。",
			"先ほどの話を覚えています。",
		]);
	} finally {
		await control("release");
		if (
			await page
				.getByRole("button", { name: "マイクを停止", exact: true })
				.count()
		)
			await page
				.getByRole("button", { name: "マイクを停止", exact: true })
				.click();
	}
});

test("answer emotions sit beside Eumenes, neutral and legacy motions stay hidden, and reload preserves them", async ({
	page,
}) => {
	const url = `http://127.0.0.1:${webPort}`;
	await page.route("**/api/conversations/main", (route) =>
		route.fulfill({
			json: {
				id: "main",
				revision: 1,
				messages: [
					{
						id: "u1",
						conversationId: "main",
						role: "user",
						text: "良い知らせがありました。",
						createdAt: "2026-10-09T00:00:00Z",
						runId: "r1",
					},
					{
						id: "a1",
						conversationId: "main",
						role: "assistant",
						text: "よかったですね。\n\n一緒に喜べてうれしいです。",
						createdAt: "2026-10-09T00:00:01Z",
						runId: "r1",
						delivery: {
							id: "00000000-0000-4000-8000-000000000001",
							version: 2,
							emotion: "joy",
							emotionConfidence: 0.9,
							confidence: 0.9,
							source: "system-one",
							motion: "joyful",
							tone: "bright",
							latencyMs: 100,
						},
					},
					{
						id: "a2",
						conversationId: "main",
						role: "assistant",
						text: "それは素敵な由来ですね。",
						createdAt: "2026-10-09T00:00:02Z",
						runId: "r2",
						delivery: {
							id: "00000000-0000-4000-8000-000000000002",
							version: 2,
							emotion: "warmth",
							emotionConfidence: 0.8,
							confidence: 0.8,
							source: "system-one",
							motion: "agreeing",
							tone: "bright",
							latencyMs: 70,
						},
					},
					{
						id: "a3",
						conversationId: "main",
						role: "assistant",
						text: "一時間は3600秒です。",
						createdAt: "2026-10-09T00:00:03Z",
						runId: "r3",
						avatarMotion: "sleepy",
						delivery: {
							id: "00000000-0000-4000-8000-000000000003",
							version: 2,
							emotion: "none",
							emotionConfidence: 0,
							confidence: 0,
							source: "fallback",
							motion: "neutral",
							tone: "natural",
							latencyMs: 0,
							reason: "not-expressive",
						},
					},
				],
			},
		}),
	);
	await page.emulateMedia({ colorScheme: "dark" });
	await page.setViewportSize({ width: 1100, height: 800 });
	await page.goto(`${url}/#conversation`);
	const emoji = page.getByRole("img", { name: "喜び" });
	await expect(emoji).toHaveText("😊");
	await expect(page.locator(".message-author").nth(1)).toHaveText("Eumenes😊");
	await expect(page.locator(".markdown-content").first()).toHaveText(
		"よかったですね。一緒に喜べてうれしいです。",
	);
	await expect(page.locator(".message-user [role=img]")).toHaveCount(0);
	await expect(page.getByRole("img", { name: "親しみ" })).toHaveText("🙂");
	await expect(page.locator(".message-author").last()).toHaveText("Eumenes");
	await expect(page.getByRole("img", { name: "眠い" })).toHaveCount(0);
	await page.reload();
	await expect(emoji).toBeVisible();
	await page.screenshot({
		path: "verification-reports/context-emotion-emoji-fixture.png",
	});
});

test("a long question with a one-second pause is sent once after final silence", async ({
	page,
}) => {
	const uploads: number[] = [];
	page.on("request", (request) => {
		if (
			request.method() === "POST" &&
			new URL(request.url()).pathname === "/api/voice/turns"
		)
			uploads.push(Number(request.headers()["x-sequence"]));
	});
	await page.addInitScript(() => {
		Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
			configurable: true,
			value: async () => {
				const context = new AudioContext(),
					output = context.createMediaStreamDestination();
				setTimeout(() => {
					const oscillator = context.createOscillator(),
						gain = context.createGain();
					gain.gain.value = 0.2;
					oscillator.connect(gain);
					gain.connect(output);
					oscillator.start();
					Reflect.set(window, "captureStartedAt", performance.now());
					setTimeout(() => {
						gain.gain.value = 0;
					}, 4000);
					setTimeout(() => {
						gain.gain.value = 0.2;
					}, 5000);
					setTimeout(() => oscillator.stop(), 12000);
				}, 400);
				return output.stream;
			},
		});
	});
	await page.goto(`http://127.0.0.1:${webPort}/#conversation`);
	await page.getByRole("button", { name: "音声を開始" }).click();
	await page.waitForFunction(() => {
		const started = Reflect.get(window, "captureStartedAt");
		return typeof started === "number" && performance.now() - started >= 11000;
	});
	expect(uploads).toEqual([]);
	await expect.poll(() => uploads, { timeout: 5000 }).toEqual([1]);
	await expect(page.getByRole("textbox", { name: "メッセージ" })).toHaveValue(
		"こんにちは",
	);
	await page.getByRole("button", { name: "マイクを停止" }).click();
	expect(uploads).toEqual([1]);
});
