import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture } from "./fixture";
import { closeArtifact, openSettings, saveSettings } from "./artifact-launcher";
import { settledScreenshot } from "./canvas";
import idleMonitoring from "../../spec/reference/larm-monitoring-v1/snapshot-idle.json";
import cancelledEvents from "../../spec/reference/larm-monitoring-v1/events-cancelled.json";
import {
	monitoringSnapshotSchema,
	monitoringEventsSchema,
} from "../../api/domains/larm/contracts/monitoring-v1";
import { emptyLarm } from "../../api/domains/monitoring/contracts/larm";
import { larmView } from "../../api/domains/monitoring/service/larm-history";
import { larmItems } from "../../api/domains/monitoring/service/larm-items";

const fixture = createFixture();
let webPort: number, dir: string;

test("LARM measurement quality reaches the existing fourteen-shape fallback without exposing authentication", async ({
	page,
}) => {
	const sample = monitoringSnapshotSchema.parse(idleMonitoring);
	const unavailable = sample.nodes[0]!.cpu.utilization;
	unavailable.status = "permission_denied";
	unavailable.observedAt = null;
	unavailable.interval = null;
	delete unavailable.value;
	const now = Date.parse(sample.generatedAt),
		state = emptyLarm(now);
	state.snapshot = sample;
	state.snapshotReceivedAt = now;
	state.bootEpoch = sample.bootEpoch;
	state.snapshotStatus = state.eventsStatus = { status: "ok", at: now };
	const { events, ...pageInfo } = monitoringEventsSchema.parse(cancelledEvents);
	state.page = pageInfo;
	const view = larmView(state, events);
	await page.route("**/api/settings", async (route) => {
		const response = await route.fetch();
		const settings = await response.json();
		await route.fulfill({
			json: {
				...settings,
				general: {
					...settings.general,
					background: "spatial",
					spatialDemoEnabled: false,
				},
			},
		});
	});
	await page.route("**/api/monitoring/snapshot", (route) =>
		route.fulfill({
			json: { observedAt: now, items: larmItems(view, {}, now), larm: view },
		}),
	);
	await page.goto(`http://127.0.0.1:${webPort}/`);
	const host = page.locator(".chat-panel .spatial-background");
	await expect(host).toHaveAttribute("data-background-state", "ready");
	await expect(host).toHaveAttribute("data-model-count", "14");
	await page.evaluate(() => {
		const canvas = document.querySelector<HTMLCanvasElement>(
			".chat-panel .spatial-background canvas",
		)!;
		canvas
			.getContext("webgl2")!
			.getExtension("WEBGL_lose_context")!
			.loseContext();
	});
	await expect(host).toHaveAttribute("data-background-state", "failed");
	await page
		.getByRole("button", { name: "LARM CPU：未確認", exact: true })
		.click();
	await expect(page.getByText("計測権限なし", { exact: true })).toBeVisible();
	await expect(
		page
			.locator(".spatial-selection-detail")
			.getByText("利用率", { exact: true }),
	).toHaveCount(0);
	await page.screenshot({
		path: test.info().outputPath("spatial-larm-measurement-quality.png"),
	});
});
test.beforeAll(async () => {
	const apiPort = await fixture.port();
	webPort = await fixture.port();
	dir = mkdtempSync(join(tmpdir(), "eumenes-spatial-"));
	await fixture.launch(
		["scripts/toolchain-fixture-server.ts"],
		{
			EUMENES_PORT: String(apiPort),
			EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
		},
		{ ports: [apiPort] },
	);
	await fixture.launchWeb({
		webPort,
		apiPort,
		token: "fixture-token-for-toolchain-browser",
		cacheDir: join(dir, "cache"),
	});
	await fixture.waitUntil(
		async () => (await fetch(`http://127.0.0.1:${webPort}`)).ok,
		{ message: "spatial fixture unavailable" },
	);
});
test.afterAll(async () => {
	await fixture.stopAll();
	rmSync(dir, { recursive: true, force: true });
});

async function settings(page: Page) {
	await openSettings(page, "表示");
}
async function save(page: Page) {
	await saveSettings(page);
	await closeArtifact(page, "表示");
	await closeArtifact(page, "設定");
}

test("14 models, saved zero-speed pause, demo health, resize, context loss and recovery", async ({
	page,
}) => {
	test.setTimeout(60000);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (
			message.type() === "error" &&
			/WebGL|shader|program/.test(message.text())
		)
			errors.push(message.text());
	});
	await page.goto(`http://127.0.0.1:${webPort}/`);
	await settings(page);
	await page
		.getByRole("group", { name: "会話の背景" })
		.getByRole("button", { name: "Spatial" })
		.click();
	await page
		.getByRole("button", { name: "状態プレビュー", exact: true })
		.click();
	await page.getByLabel("状態プレビューを使う", { exact: true }).check();
	await page.getByLabel("プレビューのhealth").selectOption("healthy");
	await page.getByRole("button", { name: "動き", exact: true }).click();
	const orbit = page.getByLabel("公転速度（%）");
	await orbit.focus();
	await orbit.press("Home");
	await expect(orbit).toHaveValue("0");
	await page.getByLabel("動きを停止", { exact: true }).check();
	await page.screenshot({
		path: test.info().outputPath("spatial-settings.png"),
	});
	await save(page);
	const host = page.locator(".chat-panel .spatial-background");
	await expect(host).toHaveAttribute("data-model-count", "14");
	await expect(host).toHaveAttribute("data-background-state", "paused");
	await expect(
		page.getByRole("button", { name: "状態を見る", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("combobox", { name: "会話モデル", exact: true }),
	).toHaveCount(0);
	const canvas = host.locator("canvas");
	const still = await settledScreenshot(canvas);
	expect(await canvas.screenshot()).toEqual(still);
	await page.screenshot({
		path: test.info().outputPath("spatial-galaxy-wide.png"),
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(canvas).toBeVisible();
	await page.screenshot({
		path: test.info().outputPath("spatial-galaxy-portrait.png"),
	});
	await page.setViewportSize({ width: 1280, height: 720 });
	await settings(page);
	await page.getByRole("button", { name: "動き", exact: true }).click();
	await expect(page.getByLabel("公転速度（%）")).toHaveValue("0");
	await page.getByLabel("公転速度（%）").focus();
	for (let i = 0; i < 5; i++)
		await page.getByLabel("公転速度（%）").press("ArrowRight");
	await expect(page.getByLabel("公転速度（%）")).toHaveValue("5");
	await page.getByLabel("動きを停止", { exact: true }).uncheck();
	await save(page);
	await expect(host).toHaveAttribute("data-background-state", "ready");
	const moving = await canvas.screenshot();
	await expect
		.poll(async () => (await canvas.screenshot()).equals(moving), {
			timeout: 10_000,
			intervals: [100, 250, 500],
		})
		.toBe(false);
	await page.evaluate(() => {
		const canvas = document.querySelector<HTMLCanvasElement>(
			".chat-panel .spatial-background canvas",
		)!;
		const gl = canvas.getContext("webgl2")!;
		gl.getExtension("WEBGL_lose_context")!.loseContext();
	});
	await expect(host).toHaveAttribute("data-background-state", "failed");
	await expect(host.locator("canvas")).toHaveCount(0);
	await expect(
		page.getByText("背景を表示できません。状態一覧は確認できます。"),
	).toBeVisible();
	await expect(
		page.locator(".spatial-background-summary li button"),
	).toHaveCount(14);
	await expect(
		page.getByRole("button", { name: "CPU：正常", exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "再表示", exact: true }).click();
	await expect(host).toHaveAttribute("data-background-state", "ready");
	await expect(host.locator("canvas")).toHaveCount(1);
	await page.reload();
	await expect(host).toHaveAttribute("data-background-state", "ready");
	expect(errors).toEqual([]);
});

test("registered display revision exposes tabs and applies particle/motion fields through shared draft", async ({
	page,
}) => {
	await page.goto(`http://127.0.0.1:${webPort}/`);
	await settings(page);
	await page.getByRole("button", { name: "粒子", exact: true }).click();
	const core = page.getByLabel("元の形を残す割合（%）");
	await core.focus();
	await core.press("Home");
	await core.press("ArrowRight");
	await page.getByRole("button", { name: "動き", exact: true }).click();
	const orbit = page.getByLabel("公転速度（%）");
	await orbit.focus();
	await orbit.press("Home");
	await expect(orbit).toHaveValue("0");
	await saveSettings(page);
	await page.screenshot({
		path: test.info().outputPath("spatial-registered-settings.png"),
	});
	await page.reload();
	await settings(page);
	await page.getByRole("button", { name: "動き", exact: true }).click();
	await expect(page.getByLabel("公転速度（%）")).toHaveValue("0");
	await page.getByRole("button", { name: "粒子", exact: true }).click();
	await expect(page.getByLabel("元の形を残す割合（%）")).toHaveValue("11");
});
