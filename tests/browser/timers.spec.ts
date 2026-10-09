import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const TOKEN = "fixture-token-for-toolchain-browser";

async function port() {
	const s = createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	const p = (s.address() as AddressInfo).port;
	await new Promise<void>((r) => s.close(() => r()));
	return p;
}

test.setTimeout(60000);
let apiPort: number, webPort: number;
const processes: ChildProcess[] = [];

test.beforeAll(async () => {
	apiPort = await port();
	webPort = await port();
	processes.push(
		spawn("bun", ["scripts/toolchain-fixture-server.ts"], {
			env: {
				...process.env,
				EUMENES_PORT: String(apiPort),
				EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
				EUMENES_FIXTURE_TIMERS: "1",
			},
			stdio: "ignore",
		}),
	);
	processes.push(
		spawn("bun", ["run", "dev:web", "--port", String(webPort)], {
			env: {
				...process.env,
				EUMENES_PROXY_URL: `http://127.0.0.1:${apiPort}`,
				EUMENES_API_TOKEN: TOKEN,
				EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
				EUMENES_VITE_CACHE_DIR: `/tmp/eumenes-timers-vite-${webPort}`,
				LARM_API_TOKEN: "",
			},
			stdio: "ignore",
		}),
	);
	for (let i = 0; i < 100; i++) {
		try {
			const web = await fetch(`http://127.0.0.1:${webPort}`);
			const api = await fetch(`http://127.0.0.1:${apiPort}/api/timers`, {
				headers: { authorization: `Bearer ${TOKEN}` },
			});
			if (web.ok && api.ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("fixture_not_ready");
});

test.afterAll(async () => {
	for (const p of processes) p.kill("SIGTERM");
	await new Promise((r) => setTimeout(r, 200));
	for (const p of processes) if (p.exitCode === null) p.kill("SIGKILL");
});

test("a 90-second request opens the saved timer", async ({ page }) => {
	await page.goto(`http://127.0.0.1:${webPort}`);
	await expect(page.getByText(/接続済み/)).toBeVisible({ timeout: 20000 });
	await page.getByRole("textbox").fill("90秒タイマー測って");
	const receiptPending = page.waitForResponse(
		(response) =>
			response.url().includes("/api/timer-actions/by-run/") && response.ok(),
		{ timeout: 20000 },
	);
	await page.getByRole("button", { name: "送信", exact: true }).click();
	const receipt = await receiptPending;
	const body = (await receipt.json()) as {
		receipt: {
			action: string;
			artifact: { timerId: string };
			timer: { durationSeconds: number; id: string; dueAt: string };
		} | null;
	};
	expect(body.receipt?.action).toBe("started");
	expect(body.receipt?.timer.durationSeconds).toBe(90);
	expect(body.receipt?.artifact.timerId).toBe(body.receipt?.timer.id);
	await expect(
		page.getByRole("paragraph").filter({
			hasText: "1分30秒のタイマーを開始いたしました",
		}),
	).toBeVisible({ timeout: 20000 });
	const clock = page.getByRole("timer");
	await expect(clock).toBeVisible();
	await expect(clock).toHaveText(/^0[01]:[0-5]\d$/);
	await expect
		.poll(async () => {
			const [minutes, seconds] = (await clock.innerText())
				.split(":")
				.map(Number);
			const expected = Math.max(
				0,
				Math.ceil((Date.parse(body.receipt!.timer.dueAt) - Date.now()) / 1000),
			);
			return Math.abs(minutes! * 60 + seconds! - expected);
		})
		.toBeLessThanOrEqual(2);
});

test("the 24-hour clock fits a narrow artifact and is restored after reload", async ({
	page,
	request,
}) => {
	const started = await request.post(`http://127.0.0.1:${apiPort}/api/timers`, {
		headers: { authorization: `Bearer ${TOKEN}` },
		data: {
			requestId: crypto.randomUUID(),
			issuedAt: new Date().toISOString(),
			durationSeconds: 86400,
			label: "24時間の時計",
		},
	});
	expect(started.ok()).toBe(true);
	await page.setViewportSize({ width: 375, height: 812 });
	await page.goto(`http://127.0.0.1:${webPort}`);
	await expect(
		page.getByText("24時間の時計", { exact: true }).last(),
	).toBeVisible({ timeout: 20000 });
	const clock = page.getByRole("timer");
	await expect(clock).toHaveText(/24:00:00|23:59:\d\d/);
	const fits = await clock.evaluate(
		(element) => element.scrollWidth <= element.clientWidth + 1,
	);
	expect(fits).toBe(true);
	await page.reload();
	await expect(page.getByText(/接続済み/)).toBeVisible({ timeout: 20000 });
	await expect(
		page.getByText("24時間の時計", { exact: true }).last(),
	).toBeVisible({ timeout: 20000 });
	await expect(page.getByRole("timer")).toHaveText(/24:00:00|23:59:\d\d/);
	await page.getByRole("button", { name: "取り消す", exact: true }).click();
	await expect(page.getByText("取消済み", { exact: true })).toBeVisible();
});

test("a persisted timer expires and its notice survives closing the clock", async ({
	page,
	request,
}) => {
	const started = await request.post(`http://127.0.0.1:${apiPort}/api/timers`, {
		headers: { authorization: `Bearer ${TOKEN}` },
		data: {
			requestId: crypto.randomUUID(),
			issuedAt: new Date().toISOString(),
			durationSeconds: 20,
			label: "終了通知の検証",
		},
	});
	expect(started.ok()).toBe(true);
	const { timer } = await started.json();
	await page.goto(`http://127.0.0.1:${webPort}`);
	await expect(page.getByText(/接続済み/)).toBeVisible({ timeout: 20000 });
	await expect(
		page.getByText("終了通知の検証", { exact: true }).last(),
	).toBeVisible();
	await page
		.getByRole("button", { name: "終了通知の検証を閉じる", exact: true })
		.click();
	const notice = page
		.getByRole("region", { name: "タイマーの終了" })
		.locator(".timer-notification")
		.filter({ hasText: "終了通知の検証" });
	await expect
		.poll(
			async () =>
				(
					await (
						await request.get(
							`http://127.0.0.1:${apiPort}/api/timers/${timer.id}`,
							{ headers: { authorization: `Bearer ${TOKEN}` } },
						)
					).json()
				).timer.state,
			{ timeout: 30000 },
		)
		.toBe("elapsed");
	await expect(notice.getByText(/終了しました/)).toBeVisible({
		timeout: 20000,
	});
	const stopped = page.waitForResponse(
		(response) =>
			response.url().endsWith(`/api/timers/${timer.id}/cancel`) &&
			response.ok(),
	);
	await notice.getByRole("button", { name: "通知を停止" }).click();
	expect((await (await stopped).json()).action).toBe("dismissed");
	await expect(notice).toHaveCount(0, { timeout: 15000 });
});

test("the timer has usable controls and fits both themes and a narrow screen", async ({
	page,
	request,
}) => {
	const started = await request.post(`http://127.0.0.1:${apiPort}/api/timers`, {
		headers: { authorization: `Bearer ${TOKEN}` },
		data: {
			requestId: crypto.randomUUID(),
			issuedAt: new Date().toISOString(),
			durationSeconds: 180,
			label: "タイマー",
		},
	});
	expect(started.ok()).toBe(true);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`http://127.0.0.1:${webPort}`);
	await expect(
		page.getByRole("heading", { name: "3分のタイマー" }),
	).toBeVisible({ timeout: 20000 });
	const panel = page.getByRole("complementary", { name: "アーティファクト" });
	const cancel = panel.getByRole("button", { name: "取り消す", exact: true });
	expect((await cancel.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	await expect(panel.locator("time")).toHaveText(/^\d{1,2}:\d{2}$/);
	for (const theme of ["dark", "light"] as const) {
		await page.emulateMedia({ colorScheme: theme });
		await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
		if (process.env.EUMENES_TIMER_SCREENSHOTS === "1") {
			const directory = resolve("spec/verification/timers");
			await mkdir(directory, { recursive: true });
			await panel.screenshot({ path: resolve(directory, `ui-${theme}.png`) });
		}
	}
	await page.setViewportSize({ width: 375, height: 812 });
	await expect(cancel).toBeVisible();
	expect(
		await panel.evaluate(
			(element) => element.scrollWidth <= element.clientWidth + 1,
		),
	).toBe(true);
	if (process.env.EUMENES_TIMER_SCREENSHOTS === "1") {
		await panel.screenshot({
			path: resolve("spec/verification/timers/ui-mobile.png"),
		});
	}
	await cancel.click();
	await expect(panel.getByText("取消済み", { exact: true })).toBeVisible();
});

test("expiry plays one real beep and posts an assistant message even after the artifact closes", async ({
	page,
}) => {
	await page.addInitScript(() => {
		const counter = window as unknown as { timerBeeps: number };
		counter.timerBeeps = 0;
		const create = AudioContext.prototype.createBufferSource;
		AudioContext.prototype.createBufferSource = function () {
			const source = create.call(this);
			const start = source.start.bind(source);
			source.start = (...args) => {
				if (Math.abs((source.buffer?.duration ?? 0) - 0.6) < 0.01)
					counter.timerBeeps++;
				start(...args);
			};
			return source;
		};
	});
	await page.goto(`http://127.0.0.1:${webPort}`);
	await expect(page.getByText(/接続済み/)).toBeVisible({ timeout: 20000 });
	await page.getByRole("textbox").fill("3秒タイマー測って");
	const speech = page.waitForRequest(
		(request) =>
			request.url().endsWith("/api/voice/replay/audio") &&
			request.postDataJSON()?.text === "3秒のタイマーが終了しました。",
		{ timeout: 20000 },
	);
	await page.getByRole("button", { name: "送信", exact: true }).click();
	await expect(page.getByRole("timer")).toBeVisible({ timeout: 20000 });
	await page
		.getByRole("button", { name: "タイマーを閉じる", exact: true })
		.last()
		.click();
	await expect(
		page
			.getByRole("article")
			.getByText("3秒のタイマーが終了しました。", { exact: true }),
	).toBeVisible({ timeout: 20000 });
	await speech;
	await expect
		.poll(() =>
			page.evaluate(
				() => (window as unknown as { timerBeeps: number }).timerBeeps,
			),
		)
		.toBe(1);
	await page.reload();
	await expect(
		page
			.getByRole("article")
			.getByText("3秒のタイマーが終了しました。", { exact: true }),
	).toBeVisible({ timeout: 20000 });
	expect(
		await page.evaluate(
			() => (window as unknown as { timerBeeps: number }).timerBeeps,
		),
	).toBe(0);
});

test("timer notifications keep chat and artifact in the same layout columns", async ({
	page,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	// Layout fixture only: expiration and playback have separate acceptance tests.
	await page.route("**/api/timer-notifications?*", (route) =>
		route.fulfill({
			json: {
				serverNow: new Date().toISOString(),
				nextCursor: null,
				items: [
					{
						id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
						timerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
						generation: 0,
						revision: 0,
						status: "played",
						reason: null,
						dueAt: new Date().toISOString(),
						message: "画面分割の検証のタイマーが終了しました。",
					},
				],
			},
		}),
	);
	await page.goto(`http://127.0.0.1:${webPort}`);
	await expect(page.getByText(/接続済み/)).toBeVisible({ timeout: 20000 });
	const notice = page.getByRole("region", { name: "タイマーの終了" });
	await expect(notice).toBeVisible({ timeout: 10000 });
	await page
		.getByRole("button", { name: "UIショーケース", exact: true })
		.click();
	for (const width of [1840, 1280, 790, 390]) {
		await page.setViewportSize({ width, height: 1000 });
		const geometry = await page
			.locator(".workspace-layout")
			.evaluate((workspace) => {
				const chat = workspace.querySelector(".chat-panel")!;
				const artifact = workspace.querySelector(".artifact-panel")!;
				const notification = workspace.querySelector(".timer-notifications")!;
				const c = chat.getBoundingClientRect(),
					a = artifact.getBoundingClientRect();
				return {
					panelCount: [...workspace.children].filter((child) =>
						child.matches(".chat-panel, .artifact-panel"),
					).length,
					noticeInChat: chat.contains(notification),
					aligned: Math.abs(c.top - a.top) < 1,
					artifactBelow: a.top >= c.bottom - 1,
					overflow: document.documentElement.scrollWidth > innerWidth,
				};
			});
		expect(geometry.panelCount).toBe(2);
		expect(geometry.noticeInChat).toBe(true);
		expect(geometry.overflow).toBe(false);
		if (width > 900) expect(geometry.aligned).toBe(true);
		else expect(geometry.artifactBelow).toBe(true);
	}
	await page.setViewportSize({ width: 1840, height: 1000 });
	const directory = resolve("spec/verification/openui-artifact");
	await mkdir(directory, { recursive: true });
	await page.screenshot({
		path: resolve(directory, "interaction-review-notification-layout.png"),
	});
});
