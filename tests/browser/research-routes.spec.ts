import { test, expect } from "@playwright/test";
import { createFixture } from "./fixture";
const TOKEN = "fixture-token-for-toolchain-browser";
test.setTimeout(120000);
let apiPort: number, webPort: number;
const fixture = createFixture();
test.beforeAll(async () => {
	apiPort = await fixture.port();
	webPort = await fixture.port();
	await fixture.launch(
		["scripts/research-routes-fixture-server.ts"],
		{
			EUMENES_PORT: String(apiPort),
			EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
		},
		{ ports: [apiPort] },
	);
	await fixture.launchWeb({
		webPort,
		apiPort,
		token: TOKEN,
		cacheDir: `/tmp/eumenes-routes-vite-${webPort}`,
	});
	await fixture.waitUntil(
		async () => {
			const web = await fetch(`http://127.0.0.1:${webPort}`);
			const api = await fetch(
				`http://127.0.0.1:${apiPort}/api/research-routes`,
				{ headers: { authorization: `Bearer ${TOKEN}` } },
			);
			return web.ok && api.ok;
		},
		{ attempts: 150, message: "fixture_not_ready" },
	);
});
test.afterAll(async () => {
	await fixture.stopAll();
});

test("the settings panel reads, stops, releases and clears stored legacy records", async ({
	page,
}, info) => {
	await page.goto(`http://127.0.0.1:${webPort}`);
	await expect(page.getByText(/接続済み/)).toBeVisible({ timeout: 20000 });

	await page.getByRole("button", { name: "設定", exact: true }).click();
	await page.getByRole("button", { name: "取得先と手順" }).click();
	// This fixture contains a previously stored route, independent of new research.
	const item = page.getByRole("button", { name: /天気予報 鎌倉/ });
	await expect(item).toBeVisible({ timeout: 30000 });
	await expect(item).toContainText("保存済み（旧方式）", { timeout: 30000 });
	await item.click();
	const detail = page.getByRole("region", { name: /取得先 天気予報 鎌倉/ });
	await expect(detail).toContainText("鎌倉市（神奈川県）");
	await detail.getByText("手順（SKILL）").click();
	await expect(detail.locator("pre").first()).toContainText("鎌倉");
	await detail
		.getByText("保存された補足（SystemContext）", { exact: true })
		.click();
	await expect(detail.locator("pre").nth(1)).not.toBeEmpty();
	await page.screenshot({
		path: info.outputPath("research-routes-detail.png"),
		fullPage: true,
	});

	// Another client changes the state behind this page; SSE re-reads it (the 409 display itself is
	// covered by the panel's component test, since the refresh normally beats any click).
	const token = (
		await (
			await page.request.get(
				`http://127.0.0.1:${apiPort}/api/research-routes`,
				{
					headers: { authorization: `Bearer ${TOKEN}` },
				},
			)
		).json()
	).items[0];
	const other = await page.request.post(
		`http://127.0.0.1:${apiPort}/api/research-routes/${token.key}/rediscover`,
		{
			headers: {
				authorization: `Bearer ${TOKEN}`,
				origin: `http://127.0.0.1:${webPort}`,
			},
			data: {
				requestId: crypto.randomUUID(),
				expectedStateToken: token.stateToken,
			},
		},
	);
	expect(other.status()).toBe(200);
	// SSE re-fetches the detail with the new state token; the stop then succeeds.
	await expect(item).not.toContainText("保存済み（旧方式）", {
		timeout: 20000,
	});
	await detail.getByRole("button", { name: "この取得先を停止" }).click();
	await expect(detail).toContainText("この取得先を停止しました");
	await detail.getByRole("button", { name: "保存した手順を解除" }).click();
	await expect(detail).toContainText(
		"保存した手順を解除しました。調査時は資料を選び直します。",
	);

	await page.getByRole("button", { name: "取得先をすべて削除" }).click();
	await page.getByRole("button", { name: "削除する" }).click();
	await expect(page.getByText(/件の取得先を削除しました/)).toBeVisible();
	await expect(
		page.getByText("登録された取得先はまだありません。"),
	).toBeVisible();
	await page.screenshot({
		path: info.outputPath("research-routes-cleared.png"),
		fullPage: true,
	});
});
