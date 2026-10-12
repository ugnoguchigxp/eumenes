import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture } from "./fixture";

const fixture = createFixture();
let webPort: number;
let dir: string;
test.beforeAll(async () => {
	const apiPort = await fixture.port();
	webPort = await fixture.port();
	dir = mkdtempSync(join(tmpdir(), "eumenes-background-"));
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
		cacheDir: join(dir, "vite-cache"),
	});
	await fixture.waitUntil(
		async () => (await fetch(`http://127.0.0.1:${webPort}`)).ok,
		{ message: "background fixture unavailable" },
	);
});
test.afterAll(async () => {
	await fixture.stopAll();
	rmSync(dir, { recursive: true, force: true });
});

test("saved backgrounds render with WebGL, survive reload, and release the previous canvas", async ({
	page,
}) => {
	await page.goto(`http://127.0.0.1:${webPort}/`);
	await expect(
		page.locator(".light-avatar-background[data-avatar-state='ready'] canvas"),
	).toBeVisible();
	const fairy = await page
		.locator(".light-avatar-background canvas")
		.elementHandle();
	await page.getByRole("button", { name: "設定", exact: true }).click();
	await page.getByRole("button", { name: "表示", exact: true }).click();
	await page.getByLabel("会話の背景").selectOption("spatial");
	await page.getByRole("button", { name: "変更を適用", exact: true }).click();
	await expect(
		page.getByText("変更を適用しました", { exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "会話に戻る", exact: true }).click();
	await expect(
		page.locator(".spatial-background[data-background-state='ready'] canvas"),
	).toBeVisible();
	expect(await fairy!.evaluate((canvas) => canvas.isConnected)).toBe(false);
	await expect(page.locator(".light-avatar-background")).toHaveCount(0);
	await page.getByRole("button", { name: "状態を見る" }).click();
	await page.getByRole("button", { name: "CPU：未確認" }).click();
	await expect(page.getByText("選択中：CPU")).toBeVisible();
	await expect(page.getByRole("textbox", { name: "メッセージ" })).toBeVisible();
	await page.screenshot({ path: "test-results/spatial-background.png" });
	await page.reload();
	await expect(
		page.locator(".spatial-background[data-background-state='ready'] canvas"),
	).toBeVisible();
	const spatial = await page
		.locator(".spatial-background canvas")
		.elementHandle();
	await page.getByRole("button", { name: "設定", exact: true }).click();
	await page.getByRole("button", { name: "表示", exact: true }).click();
	await expect(page.getByLabel("会話の背景")).toHaveValue("spatial");
	await page.getByLabel("会話の背景").selectOption("light-fairy");
	await page.getByRole("button", { name: "変更を適用", exact: true }).click();
	await expect(
		page.getByText("変更を適用しました", { exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "会話に戻る", exact: true }).click();
	await expect(
		page.locator(".light-avatar-background[data-avatar-state='ready'] canvas"),
	).toBeVisible();
	await expect(page.locator(".spatial-background")).toHaveCount(0);
	expect(await spatial!.evaluate((canvas) => canvas.isConnected)).toBe(false);
});
