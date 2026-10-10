import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { evidencePath } from "./evidence";
import { createFixture } from "./fixture";

const TOKEN = "fixture-token-for-toolchain-browser";

test.setTimeout(60000);
let apiPort: number, webPort: number;
const fixture = createFixture();

test.beforeAll(async () => {
	apiPort = await fixture.port();
	webPort = await fixture.port();
	await fixture.launch(
		["scripts/toolchain-fixture-server.ts"],
		{
			EUMENES_PORT: String(apiPort),
			EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
			EUMENES_FIXTURE_TIMERS: "1",
		},
		{ ports: [apiPort] },
	);
	await fixture.launchWeb({
		webPort,
		apiPort,
		token: TOKEN,
		cacheDir: `/tmp/eumenes-timers-vite-${webPort}`,
	});
	await fixture.waitUntil(
		async () => {
			const web = await fetch(`http://127.0.0.1:${webPort}`);
			const api = await fetch(`http://127.0.0.1:${apiPort}/api/timers`, {
				headers: { authorization: `Bearer ${TOKEN}` },
			});
			return web.ok && api.ok;
		},
		{ message: "fixture_not_ready" },
	);
});

test.afterAll(async () => {
	await fixture.stopAll();
});

test("a 90-second request opens the saved timer", async ({ page, request }) => {
	await page.goto(`http://127.0.0.1:${webPort}`);
	await expect(page.getByText(/接続済み/)).toBeVisible({ timeout: 20000 });
	// Measure clock accuracy after first-load shader work has settled, so its
	// main-thread pause does not become part of the HTTP clock sample.
	await expect(page.locator(".light-avatar-background")).toHaveAttribute(
		"data-avatar-state",
		/^(ready|unsupported|load-failed|render-failed|resize-failed|context-lost)$/,
		{ timeout: 20000 },
	);
	await page.getByRole("textbox").fill("90秒タイマー測って");
	const receiptPending = page.waitForResponse(
		(response) =>
			response.url().includes("/api/timer-actions/by-run/") && response.ok(),
		{ timeout: 30000 },
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
	await expect(clock).toBeVisible({ timeout: 20000 });
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
	// Later tests share this backend: an expiring 90s timer must not ring during them.
	const cancelled = await request.post(
		`http://127.0.0.1:${apiPort}/api/timers/${body.receipt!.timer.id}/cancel`,
		{
			headers: { authorization: `Bearer ${TOKEN}` },
			data: {
				requestId: crypto.randomUUID(),
				issuedAt: new Date().toISOString(),
				expectedRevision: 0,
			},
		},
	);
	expect(cancelled.ok()).toBe(true);
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
		.getByRole("status", { name: "タイマーの終了" })
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
	await expect(
		notice.getByRole("heading", { name: "タイマーが終了しました" }),
	).toBeVisible({
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
			const directory = evidencePath("timers");
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
			path: evidencePath("timers/ui-mobile.png"),
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
			.getByRole("alert")
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
			.getByRole("alert")
			.getByText("3秒のタイマーが終了しました。", { exact: true }),
	).toBeVisible({ timeout: 20000 });
	expect(
		await page.evaluate(
			() => (window as unknown as { timerBeeps: number }).timerBeeps,
		),
	).toBe(0);
});

test("top-right banners and notification drawer fit desktop and mobile in both themes", async ({
	page,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	const now = new Date().toISOString();
	// Presentation fixture: real expiration, speech and repeated tones are checked separately.
	await page.route("**/api/timer-notifications?*", (route) =>
		route.fulfill({
			json: {
				serverNow: now,
				activeTimers: 0,
				nextCursor: null,
				items: Array.from({ length: 12 }, (_, index) => ({
					id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
					timerId: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, "0")}`,
					generation: 0,
					revision: 0,
					status: index === 1 ? "silent" : "played",
					reason: index === 1 ? "muted" : null,
					dueAt: new Date(Date.parse(now) - index * 60000).toISOString(),
					message:
						index === 0
							? "3分のタイマーが終了しました。"
							: `${index + 1}件目のタイマーが終了しました。`,
				})),
			},
		}),
	);
	await page.goto(`http://127.0.0.1:${webPort}`);
	await expect(page.getByText(/接続済み/)).toBeVisible({ timeout: 20000 });
	const notice = page.getByRole("status", { name: "タイマーの終了" });
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
				const notification = document.querySelector(".timer-notifications")!;
				const c = chat.getBoundingClientRect(),
					a = artifact.getBoundingClientRect(),
					n = notification.getBoundingClientRect();
				const trigger = document
					.querySelector(".notification-center-trigger")!
					.getBoundingClientRect();
				const settings = document
					.querySelector(".floating-settings")!
					.getBoundingClientRect();
				const status = document
					.querySelector(".conversation-status")!
					.getBoundingClientRect();
				return {
					panelCount: [...workspace.children].filter((child) =>
						child.matches(".chat-panel, .artifact-panel"),
					).length,
					noticeInChat: chat.contains(notification),
					aligned: Math.abs(c.top - a.top) < 1,
					artifactBelow: a.top >= c.bottom - 1,
					overflow: document.documentElement.scrollWidth > innerWidth,
					right: innerWidth - n.right,
					top: n.top,
					width: n.width,
					iconsOverlap: trigger.right > settings.left,
					statusOverlaps:
						status.right > trigger.left && status.bottom > trigger.top,
				};
			});
		expect(geometry.panelCount).toBe(2);
		expect(geometry.noticeInChat).toBe(false);
		expect(geometry.overflow).toBe(false);
		expect(geometry.iconsOverlap).toBe(false);
		expect(geometry.statusOverlaps).toBe(false);
		expect(geometry.right).toBeCloseTo(16, 0);
		expect(geometry.top).toBeCloseTo(64, 0);
		expect(geometry.width).toBeLessThanOrEqual(380);
		if (width > 900) expect(geometry.aligned).toBe(true);
		else expect(geometry.artifactBelow).toBe(true);
	}
	const directory = evidencePath("timers");
	await mkdir(directory, { recursive: true });
	for (const theme of ["dark", "light"] as const) {
		await page.emulateMedia({ colorScheme: theme });
		await page.setViewportSize({ width: 1280, height: 900 });
		await expect(
			notice.getByRole("button", { name: "通知を停止" }).first(),
		).toBeEnabled();
		await expect(page.locator(".notification-center-overlay")).toHaveCount(0);
		await page.screenshot({
			path: resolve(directory, `notification-banner-${theme}.png`),
		});
		const trigger = page.getByRole("button", { name: "通知センター、12件" });
		await trigger.click();
		const drawer = page.getByRole("dialog", { name: "通知センター" });
		await expect(drawer).toBeVisible();
		await expect(drawer.getByRole("article")).toHaveCount(12);
		await expect(notice).toHaveCount(0);
		await page.screenshot({
			path: resolve(directory, `notification-center-${theme}.png`),
		});
		await page.setViewportSize({ width: 390, height: 844 });
		const bounds = await drawer.boundingBox();
		expect(bounds!.x).toBeGreaterThanOrEqual(0);
		expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
		expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
		await drawer
			.getByText("12件目のタイマーが終了しました。", { exact: true })
			.scrollIntoViewIfNeeded();
		await expect(
			drawer.getByText("12件目のタイマーが終了しました。", { exact: true }),
		).toBeInViewport();
		await drawer
			.getByText("3分のタイマーが終了しました。", { exact: true })
			.scrollIntoViewIfNeeded();
		await page.screenshot({
			path: resolve(directory, `notification-center-mobile-${theme}.png`),
		});
		await page.keyboard.press("Escape");
		await expect(drawer).toHaveCount(0);
		await expect(trigger).toBeFocused();
		await expect(notice).toBeVisible();
	}
	// Notification UI is global even when the workspace is hidden by settings.
	await page.getByRole("button", { name: "設定", exact: true }).click();
	await expect(notice).toBeVisible();
	await page.getByRole("button", { name: "通知センター、12件" }).click();
	await expect(
		page.getByRole("dialog", { name: "通知センター" }),
	).toBeVisible();
	await page.getByRole("button", { name: "通知センターを閉じる" }).click();
	await expect(page.getByRole("dialog", { name: "通知センター" })).toHaveCount(
		0,
	);
});

test("a restored alarm waits for audio activation and then beeps and requests TTS", async ({
	page,
	request,
}) => {
	const started = await request.post(`http://127.0.0.1:${apiPort}/api/timers`, {
		headers: { authorization: `Bearer ${TOKEN}` },
		data: {
			requestId: crypto.randomUUID(),
			issuedAt: new Date().toISOString(),
			durationSeconds: 15,
			label: "音声再開の確認",
		},
	});
	expect(started.ok()).toBe(true);
	const { timer } = await started.json();
	await page.addInitScript(() => {
		const counter = window as unknown as {
			timerBeeps: number;
			pendingRepeatTimers: () => number;
		};
		counter.timerBeeps = 0;
		// Track the repeat loop's 2.5s wait so the test can observe it being cleared.
		const pending = new Set<unknown>();
		const nativeSet = window.setTimeout.bind(window);
		const nativeClear = window.clearTimeout.bind(window);
		window.setTimeout = ((
			fn: TimerHandler,
			ms?: number,
			...args: unknown[]
		) => {
			if (ms !== 2500) return nativeSet(fn, ms, ...args);
			const id: unknown = nativeSet(() => {
				pending.delete(id);
				if (typeof fn === "function") fn(...args);
			}, ms);
			pending.add(id);
			return id as number;
		}) as typeof window.setTimeout;
		window.clearTimeout = ((id?: number) => {
			pending.delete(id);
			nativeClear(id);
		}) as typeof window.clearTimeout;
		counter.pendingRepeatTimers = () => pending.size;
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
	const message = "「音声再開の確認」のタイマー（15秒）が終了しました。";
	await expect(
		page.getByRole("status", { name: "タイマーの終了" }).getByText(message),
	).toBeVisible({ timeout: 20000 });
	const getNote = async () =>
		(
			await (
				await request.get(
					`http://127.0.0.1:${apiPort}/api/timers/${timer.id}`,
					{
						headers: { authorization: `Bearer ${TOKEN}` },
					},
				)
			).json()
		).notification;
	expect((await getNote()).status).toBe("pending");
	expect(
		await page.evaluate(
			() => (window as unknown as { timerBeeps: number }).timerBeeps,
		),
	).toBe(0);
	const speech = page.waitForRequest(
		(req) =>
			req.url().endsWith("/api/voice/replay/audio") &&
			req.postDataJSON()?.text === message,
	);
	await page.getByRole("button", { name: "通知音を有効にする" }).click();
	await speech;
	await expect
		.poll(() =>
			page.evaluate(
				() => (window as unknown as { timerBeeps: number }).timerBeeps,
			),
		)
		.toBe(1);
	await expect.poll(async () => (await getNote()).status).toBe("played");
	await expect
		.poll(() =>
			page.evaluate(
				() => (window as unknown as { timerBeeps: number }).timerBeeps,
			),
		)
		.toBeGreaterThanOrEqual(2);
	await mkdir(evidencePath("timers"), { recursive: true });
	await page
		.getByRole("status", { name: "タイマーの終了" })
		.screenshot({ path: evidencePath("timers/audio-repeat.png") });
	// Earlier tests leave their own notices in this shared backend; stop only ours.
	await page
		.getByRole("status", { name: "タイマーの終了" })
		.locator(".timer-notification")
		.filter({ hasText: message })
		.getByRole("button", { name: "通知を停止" })
		.click();
	await expect
		.poll(async () => (await getNote())?.status ?? "dismissed")
		.toBe("dismissed");
	const stoppedAt = await page.evaluate(
		() => (window as unknown as { timerBeeps: number }).timerBeeps,
	);
	await expect
		.poll(
			() =>
				page.evaluate(
					() => (window as unknown as { timerBeeps: number }).timerBeeps,
				),
			{ timeout: 4000 },
		)
		.toBe(stoppedAt);
	// The repeat loop waits 2.5s between beeps in a page timer. Stopping must clear
	// it, so no further beep can be scheduled; no need to sit through the interval.
	await expect
		.poll(() =>
			page.evaluate(() =>
				(
					window as unknown as { pendingRepeatTimers: () => number }
				).pendingRepeatTimers(),
			),
		)
		.toBe(0);
	expect(
		await page.evaluate(
			() => (window as unknown as { timerBeeps: number }).timerBeeps,
		),
	).toBe(stoppedAt);
});
