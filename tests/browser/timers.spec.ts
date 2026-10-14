import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { openFromLauncher } from "./artifact-launcher";
import { evidencePath } from "./evidence";
import { createFixture } from "./fixture";

const TOKEN = "fixture-token-for-toolchain-browser";
/** The single launcher entry and tab title of the registered (data-driven) timer screen. */
const TITLE = "タイマー";
const ACTIONS = "/api/toolchain-actions";

/**
 * Opens the one launcher entry and starts a timer from the screen's own h/m/s fields.
 * The label cannot be set from the UI, so the title is the default "<duration>のタイマー".
 */
async function startFromScreen(
	page: Page,
	{ hours = "0", minutes = "0", seconds = "0" } = {},
) {
	await openFromLauncher(page, TITLE);
	await page.getByLabel("時間", { exact: true }).fill(hours);
	await page.getByLabel("分", { exact: true }).fill(minutes);
	await page.getByLabel("秒", { exact: true }).fill(seconds);
	const settled = page.waitForResponse(
		(response) =>
			response.request().method() === "POST" &&
			response.url().endsWith(ACTIONS),
	);
	await page.getByRole("button", { name: "開始する", exact: true }).click();
	const view = await (await settled).json();
	expect(view.status).toBe("accepted");
	return view.result.receipt.timer as { id: string; revision: number };
}

async function readTimer(
	request: import("@playwright/test").APIRequestContext,
	id: string,
) {
	const response = await request.get(
		`http://127.0.0.1:${apiPort}/api/timers/${id}`,
		{ headers: { authorization: `Bearer ${TOKEN}` } },
	);
	expect(response.ok()).toBe(true);
	return (await response.json()).timer as {
		state: string;
		revision: number;
		remainingSeconds: number;
	};
}

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

test("saved timers never add launcher entries or open tabs on load", async ({
	page,
	request,
}) => {
	const saved = [];
	for (const durationSeconds of [1800, 3600]) {
		const response = await request.post(
			`http://127.0.0.1:${apiPort}/api/timers`,
			{
				headers: { authorization: `Bearer ${TOKEN}` },
				data: {
					requestId: crypto.randomUUID(),
					issuedAt: new Date().toISOString(),
					durationSeconds,
					label: "タイマー",
				},
			},
		);
		expect(response.ok()).toBe(true);
		saved.push((await response.json()).timer);
	}
	let browserStarts = 0;
	page.on("request", (request) => {
		if (request.method() === "POST" && request.url().endsWith(ACTIONS))
			browserStarts++;
	});
	await page.goto(`http://127.0.0.1:${webPort}`);
	await expect(page.getByText(/接続済み/)).toBeVisible({ timeout: 20000 });
	// Seeded timers open nothing by themselves, before or after a reload.
	await expect(page.getByRole("tab")).toHaveCount(0);
	await page.reload();
	await expect(page.getByText(/接続済み/)).toBeVisible({ timeout: 20000 });
	await expect(page.getByRole("tab")).toHaveCount(0);
	await expect(page.getByRole("timer")).toHaveCount(0);
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await expect(page.getByRole("menuitem", { name: /^タイマー/ })).toHaveCount(
		1,
	);
	await expect(
		page.getByRole("menuitem", { name: TITLE, exact: true }),
	).toHaveCount(1);
	// No per-timer entry: no menu item mentions a duration or a start time.
	await expect(page.getByRole("menuitem", { name: /秒・/ })).toHaveCount(0);
	await page.getByRole("menuitem", { name: TITLE, exact: true }).click();
	await expect(
		page
			.getByRole("tablist", { name: "アーティファクトのタブ" })
			.getByRole("tab"),
	).toHaveCount(1);
	// The screen opens at its setup state; nothing was started from the browser.
	await expect(
		page.getByRole("button", { name: "開始する", exact: true }),
	).toBeVisible();
	expect(browserStarts).toBe(0);
	for (const timer of saved) {
		const cancelled = await request.post(
			`http://127.0.0.1:${apiPort}/api/timers/${timer.id}/cancel`,
			{
				headers: { authorization: `Bearer ${TOKEN}` },
				data: {
					requestId: crypto.randomUUID(),
					issuedAt: new Date().toISOString(),
					expectedRevision: timer.revision,
				},
			},
		);
		expect(cancelled.ok()).toBe(true);
	}
});

test("the timer launcher works before any timer exists and starts a saved clock", async ({
	page,
	request,
}) => {
	// Capturing three layouts plus a full reload adds a second cold WebGL start.
	if (process.env.EUMENES_TIMER_SCREENSHOTS === "1") test.setTimeout(90000);
	await page.goto(`http://127.0.0.1:${webPort}`);
	await openFromLauncher(page, TITLE);
	await expect(
		page
			.locator(".timer-workspace")
			.getByRole("heading", { name: "タイマー", exact: true }),
	).toBeVisible();
	if (process.env.EUMENES_TIMER_SCREENSHOTS === "1") {
		const directory = evidencePath("clock-fixed-layout-2026-10-13");
		await mkdir(directory, { recursive: true });
		for (const theme of ["light", "dark"] as const) {
			await page.setViewportSize({ width: 1440, height: 1000 });
			await page.emulateMedia({ colorScheme: theme });
			await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
			await page.locator(".timer-workspace").screenshot({
				path: resolve(directory, `setup-${theme}.png`),
				animations: "disabled",
			});
		}
		await page.setViewportSize({ width: 375, height: 1100 });
		await page
			.getByRole("separator", { name: "会話とアーティファクトのサイズを調整" })
			.focus();
		await page.keyboard.press("Home");
		await expect(page.locator(".timer-workspace")).toBeVisible();
		expect(
			await page
				.locator(".timer-workspace")
				.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
		).toBe(true);
		await page.locator(".timer-workspace").screenshot({
			path: resolve(directory, "setup-mobile.png"),
			animations: "disabled",
		});
		await page.setViewportSize({ width: 1440, height: 1000 });
		await expect(
			page.getByRole("separator", {
				name: "会話とアーティファクトのサイズを調整",
			}),
		).toHaveAttribute("aria-orientation", "vertical");
	}
	const workspace = page.locator(".timer-workspace");
	const fixedLayout = () =>
		workspace.evaluate((element) => {
			const box = element.getBoundingClientRect();
			return [
				".timer-workspace-dial",
				".timer-workspace-time-inputs",
				".timer-workspace-presets",
				".timer-workspace-actions",
			].map((selector) => {
				const rect = element.querySelector(selector)!.getBoundingClientRect();
				return [
					rect.left - box.left,
					rect.top - box.top,
					rect.width,
					rect.height,
				];
			});
		});
	const setupLayout = await fixedLayout();
	const geometry = await workspace.evaluate((element) => {
		const box = element.getBoundingClientRect();
		const title = element.querySelector("h2")!.getBoundingClientRect();
		const dial = element
			.querySelector(".timer-workspace-dial")!
			.getBoundingClientRect();
		const presets = Array.from(
			element.querySelectorAll(".timer-workspace-presets button"),
		).map((button) => button.getBoundingClientRect());
		return {
			height: box.height,
			titleOffset: title.left - box.left,
			dialGap: dial.top - title.bottom,
			dialRight: dial.right,
			presetRightInset: box.right - presets[0]!.right,
			presets: presets.map((button) => ({ x: button.x, y: button.y })),
		};
	});
	expect(geometry.height).toBeLessThan(500);
	expect(geometry.titleOffset).toBeLessThanOrEqual(20);
	expect(geometry.dialGap).toBeLessThan(30);
	expect(geometry.presetRightInset).toBeCloseTo(16, 0);
	expect(
		geometry.presets.every((button) => button.x >= geometry.dialRight),
	).toBe(true);
	expect(new Set(geometry.presets.map((button) => button.x)).size).toBe(1);
	expect(geometry.presets[4]!.y).toBeGreaterThan(geometry.presets[0]!.y);
	await page.getByRole("button", { name: "5分", exact: true }).click();
	await expect(page.getByLabel("分", { exact: true })).toHaveValue("05");
	await page.getByLabel("分", { exact: true }).fill("1");
	await page.getByLabel("秒", { exact: true }).fill("30");
	await expect(page.getByLabel("名前（任意）")).toHaveCount(0);
	const receiptPending = page.waitForResponse(
		(response) =>
			response.request().method() === "POST" &&
			response.url().endsWith(ACTIONS),
	);
	await page.getByRole("button", { name: "開始する", exact: true }).click();
	const response = await receiptPending;
	expect(response.ok()).toBe(true);
	// The common action host settles with the timers domain's own receipt inside its result.
	const settled = await response.json();
	expect(settled.status).toBe("accepted");
	const receipt = settled.result.receipt;
	expect(receipt.timer.durationSeconds).toBe(90);
	await expect(
		workspace.getByRole("button", { name: "停止する", exact: true }),
	).toBeEnabled();
	const runningLayout = await fixedLayout();
	for (const [i, box] of setupLayout.entries()) {
		for (const [axis, value] of box.entries())
			expect(runningLayout[i]![axis]).toBeCloseTo(value, 0);
	}
	await expect(page.getByLabel("分", { exact: true })).toHaveAttribute(
		"readonly",
		"",
	);
	await expect(
		workspace.getByRole("button", { name: "10分", exact: true }),
	).toBeDisabled();
	await expect(page.getByRole("timer")).toBeVisible();
	await expect(
		page.getByText("1分30秒のタイマー", { exact: true }),
	).toBeVisible();
	if (process.env.EUMENES_TIMER_SCREENSHOTS === "1") {
		await page.locator(".timer-workspace").screenshot({
			path: evidencePath("clock-fixed-layout-2026-10-13/running-dark.png"),
			animations: "disabled",
		});
	}
	await expect(page.getByRole("timer")).toBeVisible();
	await page.getByRole("button", { name: "停止する", exact: true }).click();
	await expect(page.getByText("停止中", { exact: true })).toBeVisible();
	const pausedLayout = await fixedLayout();
	for (const [i, box] of setupLayout.entries()) {
		for (const [axis, value] of box.entries())
			expect(pausedLayout[i]![axis]).toBeCloseTo(value, 0);
	}
	const paused = await readTimer(request, receipt.timer.id);
	expect(paused.state).toBe("paused");
	const frozen = await page.getByRole("timer").innerText();
	await expect(page.locator(".timer-workspace time")).toHaveCount(0);
	if (process.env.EUMENES_TIMER_SCREENSHOTS === "1") {
		await page.emulateMedia({ colorScheme: "dark" });
		await page.locator(".timer-workspace").screenshot({
			path: evidencePath("clock-fixed-layout-2026-10-13/paused-dark.png"),
			animations: "disabled",
		});
	}
	const resumedResponse = page.waitForResponse(
		(response) =>
			response.request().method() === "POST" &&
			response.url().endsWith(ACTIONS) &&
			response.ok(),
	);
	await page.getByRole("button", { name: "再開する", exact: true }).click();
	const resumed = (await (await resumedResponse).json()).result.receipt;
	expect(resumed.timer.id).toBe(receipt.timer.id);
	expect(resumed.timer.startedAt).toBe(receipt.timer.startedAt);
	expect(resumed.timer.remainingSeconds).toBe(paused.remainingSeconds);
	await expect(page.getByText("計測中", { exact: true })).toBeVisible();
	await expect
		.poll(async () => {
			return (await page.getByRole("timer").innerText())
				.split(":")
				.map(Number)
				.reduce((total, part) => total * 60 + part, 0);
		})
		.toBeLessThan(paused.remainingSeconds);
	// Pause again so the saved state can be checked after a reload without a ringing timer.
	await page.getByRole("button", { name: "停止する", exact: true }).click();
	await expect(page.getByText("停止中", { exact: true })).toBeVisible();
	const pausedAgain = await readTimer(request, receipt.timer.id);
	expect(pausedAgain.state).toBe("paused");
	expect(frozen).toMatch(/^\d{2}:\d{2}:\d{2}$/);
	await page
		.getByRole("button", { name: "新しいタイマー", exact: true })
		.click();
	await expect(
		page
			.locator(".timer-workspace")
			.getByRole("heading", { name: "タイマー", exact: true }),
	).toBeVisible();
	expect(
		await page
			.getByRole("tablist", { name: "アーティファクトのタブ" })
			.getByRole("tab", { name: TITLE, exact: true })
			.count(),
	).toBe(1);
	// The screen cannot reopen an existing timer after a reload: no tab comes back, the
	// launcher keeps its single entry, and the saved state stays readable from the API.
	await page.reload();
	await expect(page.getByText(/接続済み/)).toBeVisible({ timeout: 20000 });
	await expect(page.getByRole("tab")).toHaveCount(0);
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await expect(page.getByRole("menuitem", { name: /^タイマー/ })).toHaveCount(
		1,
	);
	await page.keyboard.press("Escape");
	const afterReload = await readTimer(request, receipt.timer.id);
	expect(afterReload.state).toBe("paused");
	expect(afterReload.remainingSeconds).toBe(pausedAgain.remainingSeconds);
	// Terminal cleanup avoids another default-label timer in later tests.
	const cleanup = await request.post(
		`http://127.0.0.1:${apiPort}/api/timers/${receipt.timer.id}/cancel`,
		{
			headers: { authorization: `Bearer ${TOKEN}` },
			data: {
				requestId: crypto.randomUUID(),
				issuedAt: new Date().toISOString(),
				expectedRevision: afterReload.revision,
			},
		},
	);
	expect(cleanup.ok()).toBe(true);
});

test("stopwatch continues across clock and artifact tabs, stops, resumes, resets and closes", async ({
	page,
}) => {
	await page.goto(`http://127.0.0.1:${webPort}`);
	await openFromLauncher(page, TITLE);
	const clock = page.locator(".timer-workspace");
	const modes = clock.getByRole("group", { name: "時計の種類" });
	await page.clock.install();
	await modes
		.getByRole("button", { name: "ストップウォッチ", exact: true })
		.click();
	await clock.getByRole("button", { name: "開始する", exact: true }).click();
	await page.clock.runFor(1500);
	const digits = clock.getByRole("timer", {
		name: "ストップウォッチの経過時間",
	});
	await expect(digits).not.toHaveText("00:00");
	await expect(
		clock.getByRole("button", { name: "リセット", exact: true }),
	).toBeDisabled();
	await clock.getByRole("button", { name: "停止する", exact: true }).click();
	const stopped =
		(await digits.innerText()) +
		(await clock.locator(".stopwatch-workspace-fraction").innerText());
	await page.clock.runFor(3000);
	expect(
		(await digits.innerText()) +
			(await clock.locator(".stopwatch-workspace-fraction").innerText()),
	).toBe(stopped);
	await clock.getByRole("button", { name: "再開する", exact: true }).click();
	await modes.getByRole("button", { name: "タイマー", exact: true }).click();
	await page.clock.runFor(2200);
	await modes
		.getByRole("button", { name: "ストップウォッチ", exact: true })
		.click();
	const seconds = async () => {
		const parts = (await digits.innerText()).split(":").map(Number);
		return parts[0]! * 60 + parts[1]!;
	};
	await expect.poll(seconds).toBeGreaterThanOrEqual(3);
	await openFromLauncher(page, "設定");
	await page.clock.runFor(2000);
	await page
		.getByRole("tablist", { name: "アーティファクトのタブ" })
		.getByRole("tab", { name: TITLE, exact: true })
		.click();
	await expect(
		modes.getByRole("button", { name: "ストップウォッチ" }),
	).toHaveAttribute("aria-pressed", "true");
	await expect.poll(seconds).toBeGreaterThanOrEqual(5);
	await clock.getByRole("button", { name: "停止する", exact: true }).click();
	if (process.env.EUMENES_TIMER_SCREENSHOTS === "1") {
		const directory = evidencePath("clock-fixed-layout-2026-10-13");
		await mkdir(directory, { recursive: true });
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.emulateMedia({ colorScheme: "dark" });
		await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
		await clock.screenshot({
			path: resolve(directory, "stopwatch-dark.png"),
			animations: "disabled",
		});
		await page.setViewportSize({ width: 375, height: 1000 });
		await expect(
			clock.getByRole("button", { name: "再開する", exact: true }),
		).toBeInViewport();
		await expect(
			clock.getByRole("button", { name: "リセット", exact: true }),
		).toBeInViewport();
		await clock.screenshot({
			path: resolve(directory, "stopwatch-mobile.png"),
			animations: "disabled",
		});
	}
	await clock.getByRole("button", { name: "リセット", exact: true }).click();
	await expect(digits).toHaveText("00:00");
	await expect(clock.locator(".stopwatch-workspace-fraction")).toHaveText(
		".00",
	);
	await page
		.getByRole("button", { name: `${TITLE}を閉じる`, exact: true })
		.click();
	await openFromLauncher(page, TITLE);
	await modes
		.getByRole("button", { name: "ストップウォッチ", exact: true })
		.click();
	await expect(digits).toHaveText("00:00");
	await expect(
		clock.getByRole("button", { name: "開始する", exact: true }),
	).toBeVisible();
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
			hasText: "90秒のタイマーを開始しました",
		}),
	).toBeVisible({ timeout: 20000 });
	const clock = page.getByRole("timer");
	await expect(clock).toBeVisible({ timeout: 20000 });
	await expect(clock).toHaveText(/^00:0[01]:[0-5]\d$/);
	await expect
		.poll(async () => {
			const actual = (await clock.innerText())
				.split(":")
				.map(Number)
				.reduce((total, part) => total * 60 + part, 0);
			const expected = Math.max(
				0,
				Math.ceil((Date.parse(body.receipt!.timer.dueAt) - Date.now()) / 1000),
			);
			return Math.abs(actual - expected);
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

test("the 24-hour clock fits a narrow artifact and its saved state survives a reload", async ({
	page,
	request,
}) => {
	await page.setViewportSize({ width: 375, height: 812 });
	await page.goto(`http://127.0.0.1:${webPort}`);
	const timer = await startFromScreen(page, { hours: "24" });
	await expect(
		page.getByText("24時間のタイマー", { exact: true }).last(),
	).toBeVisible({ timeout: 20000 });
	const clock = page.getByRole("timer");
	await expect(clock).toHaveText(/24:00:00|23:59:\d\d/);
	const fits = await clock.evaluate(
		(element) => element.scrollWidth <= element.clientWidth + 1,
	);
	expect(fits).toBe(true);
	await page.getByRole("button", { name: "停止する", exact: true }).click();
	await expect(page.getByText("停止中", { exact: true })).toBeVisible();
	const paused = await readTimer(request, timer.id);
	expect(paused.state).toBe("paused");
	await page.reload();
	await expect(page.getByText(/接続済み/)).toBeVisible({ timeout: 20000 });
	await expect(page.getByRole("timer")).toHaveCount(0);
	await expect(page.getByRole("tab")).toHaveCount(0);
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await expect(page.getByRole("menuitem", { name: /^タイマー/ })).toHaveCount(
		1,
	);
	await page.keyboard.press("Escape");
	expect(await readTimer(request, timer.id)).toMatchObject({
		state: "paused",
		remainingSeconds: paused.remainingSeconds,
	});
});

test("a persisted timer expires and its notice survives closing the clock", async ({
	page,
	request,
}) => {
	await page.goto(`http://127.0.0.1:${webPort}`);
	await expect(page.getByText(/接続済み/)).toBeVisible({ timeout: 20000 });
	const timer = await startFromScreen(page, { seconds: "20" });
	await expect(
		page.getByText("20秒のタイマー", { exact: true }).last(),
	).toBeVisible();
	await page
		.getByRole("button", { name: `${TITLE}を閉じる`, exact: true })
		.click();
	const notice = page
		.getByRole("status", { name: "タイマーの終了" })
		.locator(".timer-notification")
		.filter({ hasText: "20秒のタイマー" });
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
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`http://127.0.0.1:${webPort}`);
	// The default draft is 3 minutes.
	await startFromScreen(page, { minutes: "3" });
	await expect(page.getByText("3分のタイマー", { exact: true })).toBeVisible({
		timeout: 20000,
	});
	const panel = page.getByRole("complementary", { name: "アーティファクト" });
	const cancel = panel.getByRole("button", { name: "停止する", exact: true });
	expect((await cancel.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	await expect(panel.locator("time")).toHaveText(/^\d{1,2}:\d{2}$/);
	for (const theme of ["dark", "light"] as const) {
		await page.emulateMedia({ colorScheme: theme });
		await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
		if (process.env.EUMENES_TIMER_SCREENSHOTS === "1") {
			const directory = evidencePath("timers");
			await mkdir(directory, { recursive: true });
			await panel.screenshot({
				path: resolve(directory, `ui-${theme}.png`),
				animations: "disabled",
			});
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
	await expect(panel.getByText("停止中", { exact: true })).toBeVisible();
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
		.getByRole("button", { name: `${TITLE}を閉じる`, exact: true })
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
	await openFromLauncher(page, "設定");
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
				const launcher = document
					.querySelector(".artifact-launcher-trigger")!
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
					iconsOverlap: launcher.right > trigger.left,
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
