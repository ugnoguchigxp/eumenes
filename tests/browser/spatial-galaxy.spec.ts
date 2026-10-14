import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture } from "./fixture";

const fixture = createFixture();
let webPort: number, dir: string;
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
	await page.getByRole("button", { name: "設定", exact: true }).click();
	await page.getByRole("button", { name: "表示", exact: true }).click();
}
async function save(page: Page) {
	await page.getByRole("button", { name: "変更を適用", exact: true }).click();
	await expect(
		page.getByText("変更を適用しました", { exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "会話に戻る", exact: true }).click();
}

test("12 models, settings tabs, saved zero-speed pause, demo health and focus, resize, context loss and recovery", async ({
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
	await page.getByLabel("会話の背景").selectOption("spatial");
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
	await expect(
		page.locator(".spatial-preview [data-background-state='paused'] canvas"),
	).toBeVisible();
	await page
		.locator(".spatial-preview")
		.screenshot({
			path: test.info().outputPath("spatial-all-models-preview.png"),
		});
	await page.screenshot({
		path: test.info().outputPath("spatial-settings.png"),
	});
	await save(page);
	const host = page.locator(".chat-panel .spatial-background");
	await expect(host).toHaveAttribute("data-model-count", "12");
	await expect(host).toHaveAttribute("data-background-state", "paused");
	await page.getByRole("button", { name: "状態を見る", exact: true }).click();
	await expect(page.getByRole("button", { name: /：正常$/ })).toHaveCount(12);
	await expect(page.getByText("デモ値での状態プレビュー")).toBeVisible();
	const canvas = host.locator("canvas");
	await page.waitForTimeout(1100);
	const still = await canvas.screenshot();
	await page.waitForTimeout(250);
	expect(await canvas.screenshot()).toEqual(still);
	await page.getByRole("button", { name: "CPU：正常", exact: true }).click();
	await page.waitForTimeout(1100);
	await expect(page.getByText("選択中：CPU", { exact: true })).toBeVisible();
	await page.screenshot({ path: test.info().outputPath("spatial-focus.png") });
	await page.getByLabel("health", { exact: true }).selectOption("fault");
	await expect(
		page.getByRole("button", { name: "CPU：問題あり", exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	await page.getByRole("button", { name: "全体に戻る", exact: true }).click();
	await page.waitForTimeout(1100);
	await expect(
		page.locator(".spatial-background-summary button[aria-pressed='true']"),
	).toHaveCount(0);
	await page.screenshot({
		path: test.info().outputPath("spatial-galaxy-wide.png"),
	});
	await test.info().attach("spatial-presentation", {
		contentType: "application/json",
		body: JSON.stringify(
			await page.evaluate(() => {
				const el = document.querySelector(".chat-panel .spatial-background")!;
				return {
					host: getComputedStyle(el).backgroundColor,
					canvas: getComputedStyle(el.querySelector("canvas")!).backgroundColor,
					parent: getComputedStyle(el.parentElement!).backgroundColor,
				};
			}),
		),
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
	await page.waitForTimeout(1100);
	const moving = await canvas.screenshot();
	await page.waitForTimeout(400);
	expect(await canvas.screenshot()).not.toEqual(moving);
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
	).toHaveCount(12);
	await expect(
		page.getByRole("button", { name: "CPU：問題あり", exact: true }),
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
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await page.getByRole("menuitem", { name: "設定", exact: true }).click();
	await page.getByRole("button", { name: "表示", exact: true }).click();
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
	await page
		.getByRole("button", { name: "設定の変更をすべて保存", exact: true })
		.click();
	await expect(
		page.getByRole("status").filter({ hasText: "変更を適用しました" }).first(),
	).toBeVisible();
	await page.screenshot({
		path: test.info().outputPath("spatial-registered-settings.png"),
	});
	await page.reload();
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await page.getByRole("menuitem", { name: "設定", exact: true }).click();
	await page.getByRole("button", { name: "表示", exact: true }).click();
	await page.getByRole("button", { name: "動き", exact: true }).click();
	await expect(page.getByLabel("公転速度（%）")).toHaveValue("0");
	await page.getByRole("button", { name: "粒子", exact: true }).click();
	await expect(page.getByLabel("元の形を残す割合（%）")).toHaveValue("11");
});
