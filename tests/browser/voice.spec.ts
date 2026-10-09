import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { resolveApiToken } from "../../api/infrastructure/auth-config";

const root = process.cwd();
const processes: ChildProcess[] = [];
let dir: string;
let apiPort: number, webPort: number, larmPort: number;
async function fixturePorts() {
	const servers = [createServer(), createServer(), createServer()];
	try {
		await Promise.all(
			servers.map(
				(server) =>
					new Promise<void>((resolve, reject) => {
						server.once("error", reject);
						server.listen(0, "127.0.0.1", resolve);
					}),
			),
		);
		return servers.map((server) => (server.address() as AddressInfo).port) as [
			number,
			number,
			number,
		];
	} finally {
		await Promise.all(
			servers.map(
				(server) =>
					new Promise<void>((resolve) => server.close(() => resolve())),
			),
		);
	}
}
async function ready(url: string) {
	for (let i = 0; i < 100; i++) {
		try {
			const response = await fetch(url);
			if (response.status < 500) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`server unavailable: ${url}`);
}
function launch(args: string[], env: Record<string, string> = {}) {
	const child = spawn("bun", args, {
		cwd: root,
		env: { ...process.env, ...env },
		stdio: "ignore",
	});
	processes.push(child);
	return child;
}
test.beforeAll(async () => {
	[apiPort, webPort, larmPort] = await fixturePorts();
	dir = mkdtempSync(join(tmpdir(), "eumenes-browser-"));
	launch(["scripts/larm-fixture-server.ts"], {
		LARM_FIXTURE_PORT: String(larmPort),
	});
	await ready(`http://127.0.0.1:${larmPort}/v3/agent-profiles`);
	launch(["api/application/server.ts"], {
		EUMENES_DB: join(dir, "test.sqlite3"),
		EUMENES_TOOLCHAIN_ENABLED: "0",
		EUMENES_LOG_FILE: join(dir, "logs/api.jsonl"),
		EUMENES_LOG_LEVEL: "debug",
		EUMENES_API_TOKEN: "",
		EUMENES_PORT: String(apiPort),
		EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
		LARM_BASE_URL: `http://127.0.0.1:${larmPort}`,
		LARM_API_TOKEN: "fixture-control",
		LARM_CONTROL_TOKEN: "",
	});
	await ready(`http://127.0.0.1:${apiPort}/api/status`);
	await expect
		.poll(
			async () => {
				const response = await fetch(`http://127.0.0.1:${apiPort}/api/status`, {
					headers: {
						Authorization: `Bearer ${resolveApiToken({ LARM_API_TOKEN: "fixture-control" })}`,
					},
				});
				if (!response.ok) return response.status;
				return (await response.json()).larm.state;
			},
			{ timeout: 15000 },
		)
		.toBe("ready");
	launch(["x", "vite", "--host", "127.0.0.1", "--port", String(webPort)], {
		EUMENES_VITE_CACHE_DIR: join(dir, "vite-cache"),
		EUMENES_PROXY_URL: `http://127.0.0.1:${apiPort}`,
		EUMENES_API_TOKEN: "",
		LARM_API_TOKEN: "fixture-control",
		LARM_CONTROL_TOKEN: "",
		EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
	});
	await ready(`http://127.0.0.1:${webPort}/`);
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
	for (const child of processes) child.kill("SIGTERM");
	await new Promise((resolve) => setTimeout(resolve, 200));
	for (const child of processes)
		if (child.exitCode === null) child.kill("SIGKILL");
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
	test("light avatar stays behind usable chat and releases its canvas on navigation", async ({
		playwright,
	}) => {
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
			await expect(canvas).toHaveCount(1);
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
			await page.waitForTimeout(250);
			expect((await canvas.screenshot()).equals(still)).toBe(true);
			const stillCanvas = await canvas.elementHandle();
			await page.emulateMedia({ reducedMotion: "no-preference" });
			await expect
				.poll(() => stillCanvas!.evaluate((node) => node.isConnected))
				.toBe(false);
			await expect(canvas).toHaveCount(1);
			const breathing = await canvas.screenshot();
			await page.waitForTimeout(600);
			expect((await canvas.screenshot()).equals(breathing)).toBe(false);
			const movingCanvas = await canvas.elementHandle();
			await page.emulateMedia({ reducedMotion: "reduce" });
			await expect
				.poll(() => movingCanvas!.evaluate((node) => node.isConnected))
				.toBe(false);
			await expect(canvas).toHaveCount(1);
			await page
				.getByRole("textbox", { name: "メッセージ" })
				.fill("配置の確認");
			await expect(
				page.getByRole("button", { name: "送信", exact: true }),
			).toBeEnabled();
			const composer = await page.locator(".chat-composer").boundingBox();
			expect(composer).not.toBeNull();
			expect(composer!.y + composer!.height).toBeLessThanOrEqual(844);
			for (let i = 0; i < 2; i++) {
				const menu = page.getByRole("button", { name: "設定メニュー" });
				if (await menu.count()) await menu.click();
				await page.getByRole("button", { name: "設定", exact: true }).click();
				// Software GL (swiftshader) can starve the main thread while a model builds.
				await expect(canvas)
					.toHaveCount(0, { timeout: 20000 })
					.catch(async (error) => {
						console.log(
							"avatar navigation",
							await page.evaluate(() => ({
								hash: window.location.hash,
								state: document
									.querySelector(".light-avatar-background")
									?.getAttribute("data-avatar-state"),
								hidden: document
									.querySelector(".workspace-layout")
									?.hasAttribute("hidden"),
								button: document
									.querySelector(".floating-settings")
									?.getAttribute("aria-label"),
							})),
						);
						throw error;
					});
				await page.getByRole("button", { name: "会話に戻る" }).click();
				await expect(canvas).toHaveCount(1);
			}
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
test("avatar voice controls save and survive a settings reload", async ({
	page,
}) => {
	const url = `http://127.0.0.1:${webPort}`;
	const original = await (await fetch(`${url}/api/settings`)).json();
	try {
		await page.goto(url);
		await page.getByRole("button", { name: "設定", exact: true }).click();
		await page.getByRole("button", { name: "音声", exact: true }).click();
		await expect(
			page.getByText("アバターの読み上げ音声", { exact: true }),
		).toBeVisible();
		await page
			.getByRole("combobox", { name: "キャラクター", exact: true })
			.selectOption("fixture-voice-soft");
		await expect(page.getByLabel("発話スタイル", { exact: true })).toHaveValue(
			"sweet",
		);
		await expect(
			page.getByText("クレジット: VOICEVOX:テスト話者B", { exact: true }),
		).toBeVisible();
		await page
			.getByLabel("キャラクター", { exact: true })
			.selectOption("fixture-voice");
		await expect(page.getByLabel("発話スタイル", { exact: true })).toHaveValue(
			"normal",
		);
		await page
			.getByLabel("発話スタイル", { exact: true })
			.selectOption("whisper");
		const pitch = page.getByRole("slider", { name: /声の高さ/ });
		await pitch.focus();
		await pitch.press("Home");
		for (let i = 0; i < 18; i++) await pitch.press("ArrowRight");
		const intonation = page.getByRole("slider", { name: /^抑揚/ });
		await intonation.focus();
		await intonation.press("Home");
		for (let i = 0; i < 23; i++) await intonation.press("ArrowRight");
		await page
			.getByRole("checkbox", { name: /文章に合わせて抑揚.*を変える/ })
			.check();
		const speed = page.getByRole("slider", { name: /話す速さ/ });
		await speed.focus();
		await speed.press("Home");
		for (let i = 0; i < 9; i++) await speed.press("ArrowRight");
		const volume = page.getByRole("slider", { name: /読み上げ音量/ });
		await volume.focus();
		await volume.press("End");
		for (let i = 0; i < 12; i++) await volume.press("ArrowLeft");
		await page.getByRole("button", { name: "変更を適用", exact: true }).click();
		await expect(
			page.getByRole("status").filter({ hasText: "変更を適用しました" }),
		).toBeVisible();
		const saved = await (await fetch(`${url}/api/settings`)).json();
		expect(saved.larm).toMatchObject({
			voice: "fixture-voice",
			speed: 1.4,
			style: "whisper",
			pitchScale: 0.03,
			intonationScale: 1.15,
			autoIntonation: true,
		});
		expect(saved.voice.outputVolume).toBeCloseTo(0.4);
		await page.reload();
		await page.getByRole("button", { name: "音声", exact: true }).click();
		await expect(page.getByLabel("キャラクター", { exact: true })).toHaveValue(
			"fixture-voice",
		);
		await expect(page.getByLabel("発話スタイル", { exact: true })).toHaveValue(
			"whisper",
		);
		await expect(page.getByRole("slider", { name: /声の高さ/ })).toHaveValue(
			"0.03",
		);
		await expect(page.getByRole("slider", { name: /^抑揚/ })).toHaveValue(
			"1.15",
		);
		await expect(page.getByRole("slider", { name: /話す速さ/ })).toHaveValue(
			"1.4",
		);
		await expect(
			page.getByRole("slider", { name: /読み上げ音量/ }),
		).toHaveValue("0.4");
		// Run the saved settings through the actual backend and its phrase TTS queue.
		const sessionId = crypto.randomUUID(),
			utteranceId = crypto.randomUUID();
		const bytes = new Uint8Array(44);
		bytes.set(new TextEncoder().encode("RIFF"));
		bytes.set(new TextEncoder().encode("WAVE"), 8);
		await fetch(`${url}/api/voice/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionId, generation: 1 }),
		});
		await fetch(`${url}/api/voice/turns`, {
			method: "POST",
			headers: {
				"Content-Type": "audio/wav",
				"X-Session-Id": sessionId,
				"X-Generation": "1",
				"X-Sequence": "1",
				"X-Utterance-Id": utteranceId,
			},
			body: bytes,
		});
		await expect
			.poll(
				async () =>
					(await (await fetch(`${url}/api/voice/turns/${utteranceId}`)).json())
						.status,
			)
			.toBe("ready");
		const observations = await (
			await fetch(`http://127.0.0.1:${larmPort}/fixture/observations`, {
				headers: { Authorization: "Bearer fixture-control" },
			})
		).json();
		expect(observations.ttsParameters.at(-1)).toMatchObject({
			model: "voicevox-core",
			voice: "fixture-voice",
			style: "whisper",
			speed: 1.4,
			pitch_scale: 0.03,
			intonation_scale: 1.15,
			response_format: "wav",
		});
		const usage = await (await fetch(`${url}/api/inference/usage`)).json();
		expect(
			usage
				.find(
					(u: { purpose: string; accepted: number }) =>
						u.purpose === "tts" && u.accepted,
				)
				?.providerDetails.at(-1),
		).toMatchObject({
			speechVoice: "fixture-voice",
			speechCredit: "VOICEVOX:テスト話者A",
		});
		await fetch(`${url}/api/voice/sessions/stop`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionId, generation: 1 }),
		});
	} finally {
		const current = await (await fetch(`${url}/api/settings`)).json();
		await fetch(`${url}/api/settings/apply`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				requestId: crypto.randomUUID(),
				expectedRevision: current.revision,
				settings: { ...original, revision: current.revision },
				keys: [],
			}),
		});
	}
});
test("missing catalog or character preserves saved controls until an explicit default reset", async ({
	page,
}) => {
	const url = `http://127.0.0.1:${webPort}`;
	const original = await (await fetch(`${url}/api/settings`)).json();
	const selected = {
		...original,
		larm: {
			...original.larm,
			voice: "fixture-voice",
			style: "whisper",
			speed: 1.2,
			pitchScale: 0.02,
			intonationScale: 1.1,
		},
	};
	const save = async (settings: typeof selected) => {
		const current = await (await fetch(`${url}/api/settings`)).json();
		return fetch(`${url}/api/settings/apply`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				requestId: crypto.randomUUID(),
				expectedRevision: current.revision,
				settings,
				keys: [],
			}),
		});
	};
	let mode: "failed" | "missing" | "normal" = "failed";
	await page.route(`${url}/api/inference/voices`, async (route) => {
		if (mode === "failed")
			return route.fulfill({
				status: 503,
				contentType: "application/json",
				body: JSON.stringify({ error: "unavailable" }),
			});
		if (mode === "normal") return route.continue();
		const response = await route.fetch();
		const catalog = await response.json();
		catalog.default_voice = "fixture-voice-soft";
		catalog.voices = catalog.voices.filter(
			(v: { id: string }) => v.id !== "fixture-voice",
		);
		return route.fulfill({ response, json: catalog });
	});
	try {
		await save(selected);
		await page.goto(`${url}/#settings`);
		await page.getByRole("button", { name: "音声", exact: true }).click();
		await expect(
			page.getByText(
				"声の一覧を取得できません。保存したキャラクターと調整値は保持しています。",
				{ exact: true },
			),
		).toBeVisible();
		await expect(page.getByLabel("キャラクター", { exact: true })).toHaveValue(
			"fixture-voice",
		);
		expect((await (await fetch(`${url}/api/settings`)).json()).larm).toEqual(
			selected.larm,
		);
		mode = "missing";
		await page
			.getByRole("button", { name: "声の一覧を再取得", exact: true })
			.click();
		await expect(page.getByRole("alert")).toContainText(
			"保存したキャラクターが一覧にありません",
		);
		expect((await (await fetch(`${url}/api/settings`)).json()).larm).toEqual(
			selected.larm,
		);
		mode = "normal";
		await page
			.getByRole("button", { name: "声の一覧を再取得", exact: true })
			.click();
		await expect(page.getByLabel("発話スタイル", { exact: true })).toHaveValue(
			"whisper",
		);
		await expect(page.getByRole("slider", { name: /声の高さ/ })).toHaveValue(
			"0.02",
		);
		await page
			.getByRole("button", { name: "既定のキャラクターに戻す", exact: true })
			.click();
		await expect(page.getByLabel("キャラクター", { exact: true })).toHaveValue(
			"",
		);
		await expect(page.getByLabel("発話スタイル", { exact: true })).toHaveValue(
			"normal",
		);
		await page.getByRole("button", { name: "変更を適用", exact: true }).click();
		await expect(
			page.getByRole("status").filter({ hasText: "変更を適用しました" }),
		).toBeVisible();
		expect(
			(await (await fetch(`${url}/api/settings`)).json()).larm,
		).toMatchObject({ voice: "", style: "normal", pitchScale: 0.02 });
	} finally {
		await save(original);
	}
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
			EUMENES_API_TOKEN: "",
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
	await page.waitForTimeout(100);
	const watched = [
		"/api/conversations/main/runs",
		"/api/conversations/main",
		"/api/status",
	];
	const initial = watched.map((path) => counts.get(path));
	await page.waitForTimeout(2000);
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
				EUMENES_API_TOKEN: "",
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

test("settings save, reload, theme and automatic fallback use backend credentials", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(`http://127.0.0.1:${webPort}/#settings`);
	await expect(
		page.getByRole("heading", { name: "全般", exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "接続先", exact: true }).click();
	await page
		.getByRole("button", { name: "クラウドAPIを登録", exact: true })
		.click();
	await page
		.getByLabel("接続名", { exact: true })
		.fill("Browser fixture cloud");
	await page
		.getByLabel("APIのベースURL", { exact: true })
		.fill(`http://127.0.0.1:${larmPort}/llm/v1`);
	await page
		.getByLabel("APIキー", { exact: true })
		.fill("fixture-browser-cloud-key");
	await page
		.getByLabel("モデル名", { exact: true })
		.fill("fixture-cloud-model");
	await page
		.getByRole("button", { name: "登録内容を追加", exact: true })
		.click();
	await page
		.getByLabel("LARMのURL", { exact: true })
		.fill("http://127.0.0.1:19811");
	let releaseSave: () => void = () => {};
	let saveArrived = false;
	await page.route("**/api/settings/apply", async (route) => {
		saveArrived = true;
		await new Promise<void>((resolve) => {
			releaseSave = resolve;
		});
		await route.continue();
	});
	await page.getByRole("button", { name: "変更を適用", exact: true }).click();
	await expect.poll(() => saveArrived).toBe(true);
	await page
		.getByLabel("接続名", { exact: true })
		.fill("Browser fixture cloud edited");
	releaseSave();
	await expect(
		page.getByText("送信した変更を適用しました。追加の変更は未適用です。", {
			exact: true,
		}),
	).toBeVisible();
	await expect(page.getByLabel("接続名", { exact: true })).toHaveValue(
		"Browser fixture cloud edited",
	);
	await page.unroute("**/api/settings/apply");
	await page.getByRole("button", { name: "変更を適用", exact: true }).click();
	await expect(
		page.getByText("変更を適用しました", { exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "表示", exact: true }).click();
	await page.getByLabel("テーマ", { exact: true }).selectOption("dark");
	await page.getByRole("button", { name: "変更を適用", exact: true }).click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	await page.reload();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	await page.getByRole("button", { name: "AIの使い方", exact: true }).click();
	await expect(
		page.getByLabel("クラウド代替先", { exact: true }).first(),
	).toHaveValue(/.+/);
	const doc = await page.evaluate(
		async () => await (await fetch("/api/settings")).text(),
	);
	expect(doc).not.toContain("fixture-browser-cloud-key");
	expect(doc).not.toContain("fixture-control");
	await page.screenshot({ path: "/tmp/eumenes-settings-screen.png" });
	await page.setViewportSize({ width: 390, height: 844 });
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
	await page.screenshot({ path: "/tmp/eumenes-settings-mobile.png" });
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page
		.getByRole("button", { name: "会話に戻る", exact: true })
		.first()
		.click();
	await page
		.getByLabel("メッセージ", { exact: true })
		.fill("settings fallback fixture request");
	const accepted = page.waitForResponse(
		(r) =>
			r.request().method() === "POST" &&
			new URL(r.url()).pathname === "/api/runs",
	);
	await page.getByRole("button", { name: "送信", exact: true }).click();
	const run = (await (await accepted).json()) as { id: string };
	await expect
		.poll(
			async () =>
				await page.evaluate(async (id) => {
					const rows = (await (await fetch("/api/inference/usage")).json()) as {
						subject: string;
						source: string;
						accepted: number;
					}[];
					return rows.some(
						(r) => r.subject === id && r.source === "cloud" && r.accepted === 1,
					);
				}, run.id),
		)
		.toBe(true);
	await page.getByRole("button", { name: "設定", exact: true }).click();
	await page.getByRole("button", { name: "接続先", exact: true }).click();
	await page
		.getByLabel("LARMのURL", { exact: true })
		.fill(`http://127.0.0.1:${larmPort}`);
	await page.getByRole("button", { name: "変更を適用", exact: true }).click();
	await expect(
		page.getByText("変更を適用しました", { exact: true }),
	).toBeVisible();
	// Restore the fixture connection after deliberately exercising an offline URL.
	// Later tests must not inherit its asynchronous connection preparation.
	const restored = await fetch(`http://127.0.0.1:${webPort}/api/larm/connect`, {
		method: "POST",
	});
	expect(restored.ok).toBe(true);
	await expect
		.poll(
			async () =>
				(await (await fetch(`http://127.0.0.1:${webPort}/api/status`)).json())
					.larm.state,
			{ timeout: 15000 },
		)
		.toBe("ready");
});

test("memory connection settings persist across reload and preserve saved items", async ({
	page,
}, testInfo) => {
	const url = `http://127.0.0.1:${webPort}`;
	const original = await (await fetch(`${url}/api/memory/status`)).json();
	const items = await (await fetch(`${url}/api/memory/items?all=1`)).json();
	try {
		await page.goto(`${url}/#settings`);
		await page.getByRole("button", { name: "メモリー", exact: true }).click();
		await expect(page.getByText("会話への接続", { exact: true })).toBeVisible();
		await expect(
			page.getByRole("button", { name: "変更を適用", exact: true }),
		).toHaveCount(0);
		await page.getByRole("button", { name: "メモリーを切断" }).click();
		await expect(page.getByText("非接続", { exact: true })).toBeVisible();
		expect(
			(await (await fetch(`${url}/api/memory/status`)).json()).enabled,
		).toBe(false);
		await page.reload();
		await page.getByRole("button", { name: "メモリー", exact: true }).click();
		await expect(page.getByText("非接続", { exact: true })).toBeVisible();
		await page.screenshot({
			path: testInfo.outputPath("memory-disconnected.png"),
		});
		await page.getByRole("button", { name: "メモリーを接続" }).click();
		await expect(page.getByText("接続中", { exact: true })).toBeVisible();
		expect(
			(await (await fetch(`${url}/api/memory/status`)).json()).enabled,
		).toBe(true);
		expect(await (await fetch(`${url}/api/memory/items?all=1`)).json()).toEqual(
			items,
		);
	} finally {
		await fetch(`${url}/api/memory/settings`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: original.enabled }),
		});
	}
});

test("settings schedule controls create, pause, resume and cancel future work", async ({
	page,
}) => {
	await page.goto(`http://127.0.0.1:${webPort}/#settings`);
	await page.getByRole("button", { name: "予約", exact: true }).click();
	await page
		.getByLabel("依頼内容", { exact: true })
		.fill("Browser scheduled fixture request");
	await page.getByLabel("実行日時（端末の時刻）", { exact: true }).fill(
		await page.evaluate(() => {
			const date = new Date(Date.now() + 3600000);
			date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
			return date.toISOString().slice(0, 16);
		}),
	);
	await page.getByRole("button", { name: "予約を作成", exact: true }).click();
	await expect(
		page.getByText("Browser scheduled fixture request", { exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "一時停止", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "再開", exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "再開", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "一時停止", exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "今後の予約を取消", exact: true })
		.click();
	await expect(page.getByText(/cancelled \/ 次回:/)).toBeVisible();
	await expect(
		page.getByRole("button", { name: "今後の予約を取消", exact: true }),
	).toHaveCount(0);
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
	await page.goto(`http://127.0.0.1:${webPort}/`);
	await expect(page.locator(".connection-health .health-state")).toHaveText(
		/^(接続済み|待機中)$/,
		{ timeout: 15000 },
	);
	await expect.poll(() => counts.get("/api/events") ?? 0).toBeGreaterThan(0);
	await page.waitForTimeout(600);
	// Development StrictMode remounts once; the settled page must share one stream.
	maxStreams = activeStreams;
	const before = Object.fromEntries(counts);
	await page.waitForTimeout(6200);
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
	const accepted = await fetch(`http://127.0.0.1:${webPort}/api/runs`, {
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
						await fetch(`http://127.0.0.1:${webPort}/api/runs/${run.id}`)
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
							source: "laya",
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
							source: "laya",
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

test("settings playground exercises image, music and provider health through the API", async ({
	page,
}) => {
	mkdirSync("spec/verification/service-tests", { recursive: true });
	await page.setViewportSize({ width: 1600, height: 1100 });
	await page.goto(`http://127.0.0.1:${webPort}`);
	await page.getByRole("button", { name: "設定", exact: true }).click();
	await page
		.getByRole("button", { name: "サービスを試す", exact: true })
		.click();
	await page.getByRole("button", { name: /画像生成.*fixture-image/ }).click();
	await page.getByRole("button", { name: "画像を生成", exact: false }).click();
	await expect(page.getByAltText("生成した画像")).toBeVisible();
	await expect(page.getByText("成功", { exact: true }).first()).toBeVisible();
	await page.screenshot({
		path: "spec/verification/service-tests/desktop.png",
		fullPage: true,
	});
	await page.getByRole("button", { name: /楽曲生成.*fixture-music/ }).click();
	await page.getByRole("button", { name: "楽曲を生成", exact: false }).click();
	await expect(page.locator(".test-result audio")).toBeVisible();
	await page.getByRole("button", { name: "自己診断", exact: true }).click();
	await expect(
		page.locator(".test-health").getByText("正常", { exact: true }),
	).toHaveCount(3);
	await expect(
		page.locator(".test-health").getByText("実行時に起動", { exact: true }),
	).toHaveCount(2);
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(
		page.getByRole("button", { name: "自己診断", exact: true }),
	).toBeVisible();
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
	await page.screenshot({
		path: "spec/verification/service-tests/mobile.png",
		fullPage: true,
	});
});
