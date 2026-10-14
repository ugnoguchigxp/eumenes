import { test, expect, type Page } from "@playwright/test";
import { createFixture } from "./fixture";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const fixture = createFixture();
const buildDir = mkdtempSync(join(tmpdir(), "eumenes-google-built-web-"));
const token = "fixture-token-for-toolchain-browser";
let apiPort: number, webPort: number;
// Three consent round trips, persistence checks and revocation share this full journey.
test.setTimeout(180_000);
test.beforeAll(async () => {
	apiPort = await fixture.port();
	webPort = await fixture.port();
	await fixture.launch(
		["scripts/google-accounts-fixture-server.ts"],
		{
			EUMENES_PORT: String(apiPort),
			EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
		},
		{ ports: [apiPort] },
	);
	// A fixed production build prevents another task's DesignSystem rebuild from reloading this test.
	const build = await fixture.launch([
		"x",
		"vite",
		"build",
		"--outDir",
		buildDir,
	]);
	const buildCode =
		build.exitCode ??
		(await new Promise<number | null>((resolve) =>
			build.once("exit", resolve),
		));
	expect(buildCode).toBe(0);
	await fixture.launch(
		[
			"x",
			"vite",
			"preview",
			"--host",
			"127.0.0.1",
			"--strictPort",
			"--port",
			String(webPort),
			"--outDir",
			buildDir,
		],
		{
			EUMENES_PROXY_URL: `http://127.0.0.1:${apiPort}`,
			EUMENES_API_TOKEN: token,
			EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
		},
		{ ports: [webPort] },
	);

	await fixture.waitUntil(
		async () => {
			const [web, api] = await Promise.all([
				fetch(`http://127.0.0.1:${webPort}`),
				fetch(`http://127.0.0.1:${apiPort}/api/google-accounts`, {
					headers: { authorization: `Bearer ${token}` },
				}),
			]);
			return web.ok && api.ok;
		},
		{ message: "fixture_not_ready" },
	);
});
test.afterAll(async () => {
	await fixture.stopAll();
	rmSync(buildDir, { recursive: true, force: true });
});
async function open(page: Page, navigate = true) {
	if (navigate)
		await page.goto(`http://127.0.0.1:${webPort}`, {
			waitUntil: "domcontentloaded",
		});
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await expect(
		page.getByRole("menuitem", { name: "Google連携", exact: true }),
	).toHaveCount(0);
	await page.getByRole("menuitem", { name: "設定", exact: true }).click();
	await page.getByRole("button", { name: "Google連携", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Google連携", exact: true }),
	).toBeVisible();
}
async function authorize(page: Page, button = "Googleアカウントを接続") {
	const popupPromise = page.waitForEvent("popup");
	await page.getByRole("button", { name: button, exact: true }).click();
	const popup = await popupPromise;
	await expect(
		popup.getByRole("heading", { name: "Google認証の試験画面" }),
	).toBeVisible();
	return popup;
}
test("settings account flow: denial, consent, persistence, revoked access, reconnect, disconnect", async ({
	page,
	request,
}) => {
	const started = Date.now();
	const progress = (phase: string) =>
		console.info(
			`[Google E2E] ${phase}: ${Math.round((Date.now() - started) / 1000)}s`,
		);
	await page.emulateMedia({ colorScheme: "dark" });
	await page.setViewportSize({ width: 1280, height: 1100 });
	await open(page);
	mkdirSync("verification-reports/google-accounts", { recursive: true });
	await page.locator(".ds-google-accounts").screenshot({
		path: "verification-reports/google-accounts/disconnected.png",
	});
	progress("ready");
	let popup = await authorize(page);
	await popup.getByRole("link", { name: "許可しない" }).click();
	await expect(
		popup.getByRole("heading", { name: "接続をキャンセルしました。" }),
	).toBeVisible();
	await popup.close();
	await page.bringToFront();
	await expect(
		page.getByText("接続をキャンセルしました。", { exact: true }),
	).toBeVisible();
	popup = await authorize(page);
	await popup.getByRole("link", { name: "接続を許可" }).click();
	await expect(
		popup.getByRole("heading", { name: "Googleアカウントを接続しました。" }),
	).toBeVisible();
	await popup.close();
	await page.bringToFront();
	await expect(
		page.getByText("hanako@example.com", { exact: true }),
	).toBeVisible();
	await expect(page.getByText("接続済み", { exact: true })).toBeVisible();
	await page
		.locator(".ds-google-accounts")
		.screenshot({ path: "verification-reports/google-accounts/connected.png" });
	progress("reload");
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(
		page.getByRole("tablist", { name: "アーティファクトのタブ" }),
	).toHaveCount(0);
	await open(page, false);
	await expect(
		page.getByText("hanako@example.com", { exact: true }),
	).toBeVisible();
	await expect(
		page
			.getByRole("tablist", { name: "アーティファクトのタブ" })
			.getByRole("tab"),
	).toHaveCount(2);
	const revoked = await request.post(
		`http://127.0.0.1:${apiPort}/api/fixture/google/revoke`,
		{ headers: { authorization: `Bearer ${token}` } },
	);
	expect(revoked.ok()).toBe(true);
	progress("reload");
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(
		page.getByRole("tablist", { name: "アーティファクトのタブ" }),
	).toHaveCount(0);
	await open(page, false);
	await expect(page.getByText("再接続が必要", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Googleアカウントを接続しました。", { exact: true }),
	).toHaveCount(0);
	await page
		.locator(".ds-google-accounts")
		.screenshot({ path: "verification-reports/google-accounts/reconnect.png" });
	progress("reconnect");
	popup = await authorize(page, "再接続する");
	await popup.getByRole("link", { name: "接続を許可" }).click();
	await expect(
		popup.getByRole("heading", { name: "Googleアカウントを接続しました。" }),
	).toBeVisible();
	await popup.close();
	await page.bringToFront();
	await expect(page.getByText("接続済み", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "連携を解除", exact: true }).click();
	await expect(page.getByRole("alertdialog")).toBeVisible();
	await page.getByRole("button", { name: "キャンセル", exact: true }).click();
	await expect(page.getByText("接続済み", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "連携を解除", exact: true }).click();
	await page.getByRole("button", { name: "解除する", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Googleアカウントを接続", exact: true }),
	).toBeEnabled();
	progress("reload");
	await page.reload({ waitUntil: "domcontentloaded" });
	await expect(
		page.getByRole("tablist", { name: "アーティファクトのタブ" }),
	).toHaveCount(0);
	await open(page, false);
	await expect(
		page.getByRole("button", { name: "Googleアカウントを接続", exact: true }),
	).toBeVisible();
	// A user cancels in Eumenes while Google's page is still open: its late callback is rejected.
	popup = await authorize(page);
	await page.bringToFront();
	await page.getByRole("button", { name: "キャンセル", exact: true }).click();
	await popup.getByRole("link", { name: "接続を許可" }).click();
	await expect(
		popup.getByRole("heading", { name: /接続を完了できませんでした/ }),
	).toBeVisible();
	await popup.close();
	await page.bringToFront();
	await expect(
		page.getByRole("button", { name: "Googleアカウントを接続", exact: true }),
	).toBeEnabled();
	progress("complete");
});

test("narrow settings can scroll to the connection control and profile permissions", async ({
	page,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await page.setViewportSize({ width: 420, height: 900 });
	await open(page);
	const connect = page.getByRole("button", {
		name: "Googleアカウントを接続",
		exact: true,
	});
	await connect.scrollIntoViewIfNeeded();
	await expect(connect).toBeInViewport();
	await expect(connect).toBeEnabled();
	mkdirSync("verification-reports/google-accounts", { recursive: true });
	await page
		.getByRole("tabpanel", { name: "Google連携" })
		.screenshot({ path: "verification-reports/google-accounts/narrow.png" });
	const profile = page.getByText("プロフィール画像", { exact: true });
	await profile.scrollIntoViewIfNeeded();
	await expect(profile).toBeInViewport();
	expect(
		await page
			.locator(".ds-google-accounts")
			.evaluate((el) => el.scrollWidth <= el.clientWidth),
	).toBe(true);
});
