import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const root = process.cwd();
const processes: ChildProcess[] = [];
let dir: string;
const apiPort = 18787,
	webPort = 15173,
	larmPort = 19810;
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
	dir = mkdtempSync(join(tmpdir(), "eumenes-browser-"));
	launch(["scripts/larm-fixture-server.ts"], {
		LARM_FIXTURE_PORT: String(larmPort),
	});
	await ready(`http://127.0.0.1:${larmPort}/v3/agent-profiles`);
	launch(["api/application/server.ts"], {
		EUMENES_DB: join(dir, "test.sqlite3"),
		EUMENES_API_TOKEN: "",
		EUMENES_PORT: String(apiPort),
		EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
		LARM_BASE_URL: `http://127.0.0.1:${larmPort}`,
		LARM_API_TOKEN: "fixture-control",
		LARM_CONTROL_TOKEN: "",
	});
	await ready(`http://127.0.0.1:${apiPort}/api/status`);
	launch(["x", "vite", "--host", "127.0.0.1", "--port", String(webPort)], {
		EUMENES_PROXY_URL: `http://127.0.0.1:${apiPort}`,
		EUMENES_API_TOKEN: "",
		LARM_API_TOKEN: "fixture-control",
		LARM_CONTROL_TOKEN: "",
		EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
	});
	await ready(`http://127.0.0.1:${webPort}/`);
});
test.afterAll(async () => {
	for (const child of processes) child.kill("SIGTERM");
	await new Promise((resolve) => setTimeout(resolve, 200));
	for (const child of processes)
		if (child.exitCode === null) child.kill("SIGKILL");
	rmSync(dir, { recursive: true, force: true });
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
	unavailable = false;
	await page.getByRole("button", { name: "接続を再確認" }).click();
	await expect(page.locator(".connection-health .health-state")).toHaveText(
		"ready",
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
	await expect(page.getByText(/^(playing|played)$/)).toBeVisible({
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
	await expect(page.getByText("played", { exact: true })).toBeVisible({
		timeout: 20000,
	});
	await page.getByRole("button", { name: "停止" }).click();
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
		page.getByRole("heading", { name: "AIの使い方", exact: true }),
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
		/^(ready|idle)$/,
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

test("partial ASR, arriving characters and the first speech clause precede answer completion", async ({
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
		await expect(
			page.locator(".route-node.active").filter({ hasText: "音声再生" }),
		).toBeVisible({
			timeout: 10000,
		});
		const seen = await (await control("observations")).json();
		expect(seen.ttsInputs).toEqual(["承知しました。"]);
		expect(seen.asrInputs.length).toBeGreaterThanOrEqual(2);
		expect(
			seen.asrInputs.every((a: { rate: number }) => a.rate === 16000),
		).toBe(true);
		await control("release");
		await expect(streaming).toHaveCount(0, { timeout: 10000 });
		await expect(page.getByText("played", { exact: true })).toBeVisible({
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
		if (await page.getByRole("button", { name: "停止", exact: true }).count())
			await page.getByRole("button", { name: "停止", exact: true }).click();
	}
});
