import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { createFixture } from "./fixture";
import { openFromLauncher } from "./artifact-launcher";
const fixture = createFixture();
let apiPort: number, webPort: number;
const evidence = "spec/verification/dots-no-relay-cleanup-2026-10-25";
test.setTimeout(90000);
test.use({ actionTimeout: 15000, navigationTimeout: 15000 });
let errors: string[] = [],
	badResponses: string[] = [];
test.beforeEach(({ page }) => {
	errors = [];
	badResponses = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("response", (response) => {
		if (response.status() >= 400)
			badResponses.push(
				`${response.status()} ${new URL(response.url()).pathname}`,
			);
	});
});
test.afterEach(async ({ page }) => {
	await mkdir(evidence, { recursive: true });
	await writeFile(
		`${evidence}/browser-diagnostics.json`,
		JSON.stringify({ errors, badResponses }, null, 2),
	);
	await writeFile(
		`${evidence}/browser-last.aria.txt`,
		await page
			.locator("body")
			.ariaSnapshot()
			.catch(() => "page unavailable"),
	);
	await page
		.screenshot({
			path: `${evidence}/browser-last.png`,
			fullPage: true,
			timeout: 5000,
		})
		.catch(() => {});
});
test.beforeAll(async () => {
	apiPort = await fixture.port();
	webPort = await fixture.port();
	await fixture.launch(
		["scripts/dots-delegation-fixture-server.ts"],
		{
			EUMENES_PORT: String(apiPort),
			EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
		},
		{ ports: [apiPort] },
	);
	await fixture.launchWeb({
		apiPort,
		webPort,
		token: "fixture-token-for-toolchain-browser",
		cacheDir: `/tmp/eumenes-dots-delegation-vite-${webPort}`,
	});
	await fixture.waitUntil(
		async () => {
			try {
				return (
					await fetch(`http://127.0.0.1:${apiPort}/api/toolchain-artifacts`, {
						headers: {
							authorization: "Bearer fixture-token-for-toolchain-browser",
						},
					})
				).ok;
			} catch {
				return false;
			}
		},
		{ message: "dots_fixture_not_ready" },
	);
});
test.afterAll(() => fixture.stopAll());
test("one registered artifact supports menu selection, saved results, answers, stop and persisted settings", async ({
	page,
}) => {
	const pageErrors: string[] = [],
		failed: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("response", (response) => {
		if (response.status() >= 400)
			failed.push(`${response.status()} ${new URL(response.url()).pathname}`);
	});
	await page.goto(`http://127.0.0.1:${webPort}`);
	await openFromLauncher(page, "dotsの仕事");
	await page.getByRole("button", { name: "仕事一覧", exact: true }).click();
	await expect(page.getByRole("menu", { name: "依頼した仕事" })).toBeVisible();
	await mkdir(evidence, { recursive: true });
	await page.screenshot({
		path: `${evidence}/workspace-browser.png`,
		fullPage: true,
	});
	await page.keyboard.press("Escape");
	const splitter = page.getByRole("separator", {
		name: "会話とアーティファクトのサイズを調整",
	});
	await splitter.press("End");
	await page.getByRole("button", { name: "仕事一覧", exact: true }).click();
	const menuBox = await page
			.getByRole("menu", { name: "依頼した仕事" })
			.boundingBox(),
		panelBox = await page
			.getByRole("complementary", { name: "アーティファクト" })
			.boundingBox();
	expect(menuBox!.x).toBeGreaterThanOrEqual(panelBox!.x);
	expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(
		panelBox!.x + panelBox!.width,
	);
	await page.screenshot({
		path: `${evidence}/workspace-narrow-browser.png`,
		fullPage: true,
	});
	await page.keyboard.press("Escape");
	await splitter.press("Enter");
	await page.getByRole("button", { name: "仕事一覧", exact: true }).click();
	await page.getByRole("menuitem", { name: /完了した調査/ }).click();
	await expect(page.getByRole("menu", { name: "依頼した仕事" })).toHaveCount(0);
	await expect(
		page.getByText("模擬調査の要約です。", { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "取消", exact: true }),
	).toHaveCount(0);
	await page.getByRole("button", { name: "仕事一覧", exact: true }).click();
	await page.getByRole("menuitem", { name: /確認が必要な仕事/ }).click();
	await page
		.getByRole("textbox", { name: "質問への回答" })
		.fill("対象Aで進めてください");
	await page.getByRole("button", { name: "回答を送る", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "質問への回答" })).toHaveCount(
		0,
	);
	await page.getByRole("button", { name: "取消", exact: true }).click();
	await expect(page.getByText("停止を確認中", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "設定", exact: true }).click();
	await expect(
		page.getByRole("tabpanel", { name: "dotsの設定", exact: true }),
	).toBeVisible({ timeout: 10000 });
	await expect(
		page.getByLabel("起動時に結果を受け取る", { exact: true }),
	).toHaveCount(0);
	await expect(page.getByText("受取と同期", { exact: true })).toHaveCount(0);
	await expect(page.getByText("dots依頼受付担当", { exact: true })).toHaveCount(
		0,
	);
	await page.screenshot({
		path: `${evidence}/settings-before-save.png`,
		fullPage: true,
	});
	await writeFile(
		`${evidence}/settings-before-save.aria.txt`,
		await page.locator("body").ariaSnapshot(),
	);
	await writeFile(
		`${evidence}/browser-diagnostics.json`,
		JSON.stringify({ pageErrors, failed }, null, 2),
	);
	await expect(
		page.getByLabel("作業Session数の上限", { exact: true }),
	).toBeVisible({ timeout: 10000 });
	await page.getByLabel("作業Session数の上限", { exact: true }).fill("2");
	await page
		.getByRole("button", { name: "設定の変更をすべて適用", exact: true })
		.click();
	await expect(
		page.getByText("未適用の変更はありません", { exact: true }),
	).toBeVisible();
	await page.screenshot({
		path: `${evidence}/settings-browser.png`,
		fullPage: true,
	});
	await page.reload();
	await openFromLauncher(page, "設定");
	await page.getByRole("button", { name: /dotsの設定/ }).click();
	await expect(
		page.getByLabel("作業Session数の上限", { exact: true }),
	).toHaveValue("2");
});
