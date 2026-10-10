import { test, expect } from "@playwright/test";
import { createFixture } from "./fixture";
const TOKEN = "fixture-token-for-research-routes-browser";
const QUESTION = "天気予報 鎌倉 明日 最高気温";
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

test("cold run registers a route; the settings panel reads, edits, stops, rediscovers and clears it", async ({
	page,
}, info) => {
	await page.goto(`http://127.0.0.1:${webPort}`);
	await expect(page.getByText(/接続済み/)).toBeVisible({ timeout: 20000 });
	await page.getByRole("textbox").fill(QUESTION);
	await page.getByRole("button", { name: "送信", exact: true }).click();
	await expect(page.getByText("最高26度").first()).toBeVisible({
		timeout: 30000,
	});

	await page.getByRole("button", { name: "設定", exact: true }).click();
	await page.getByRole("button", { name: "取得先と手順" }).click();
	// The list refreshes from SSE invalidation once the background registration commits.
	const item = page.getByRole("button", { name: /天気予報 鎌倉/ });
	await expect(item).toBeVisible({ timeout: 30000 });
	await expect(item).toContainText("利用中", { timeout: 30000 });
	await item.click();
	const detail = page.getByRole("region", { name: /取得先 天気予報 鎌倉/ });
	await expect(detail).toContainText("鎌倉市（神奈川県）");
	await detail.getByText("手順（SKILL）").click();
	await expect(detail.locator("pre").first()).toContainText("鎌倉");
	await detail.getByText(/会話に渡す内容/).click();
	await expect(detail.locator("pre").nth(1)).not.toBeEmpty();
	await page.screenshot({
		path: info.outputPath("research-routes-detail.png"),
		fullPage: true,
	});

	// Edit is accepted as a draft; an unsent instruction keeps the panel dirty.
	await detail.getByRole("textbox").fill("説明を少し丁寧にしてください");
	const confirm = page.waitForEvent("dialog");
	await page.getByRole("button", { name: "会話に戻る" }).click();
	const dialog = await confirm;
	expect(dialog.message()).toContain("未保存");
	await dialog.dismiss();
	await expect(detail.getByRole("textbox")).toHaveValue(
		"説明を少し丁寧にしてください",
	);
	await detail.getByRole("button", { name: "編集を依頼" }).click();
	await expect(detail).toContainText("編集を受け付けました");

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
	await expect(item).not.toContainText("利用中", { timeout: 20000 });
	await detail.getByRole("button", { name: "この取得先を停止" }).click();
	await expect(detail).toContainText("この取得先を停止しました");
	await detail.getByRole("button", { name: "次回は取得先を探し直す" }).click();
	await expect(detail).toContainText("探し直します");

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
