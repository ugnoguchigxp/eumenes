import { test, expect } from "@playwright/test";
import { createFixture } from "./fixture";

const fixture = createFixture();
let apiPort: number, webPort: number;
test.beforeAll(async () => {
	apiPort = await fixture.port();
	webPort = await fixture.port();
	await fixture.launch(
		["scripts/workers-ai-settings-fixture.ts"],
		{ EUMENES_PORT: String(apiPort) },
		{ ports: [apiPort] },
	);
	await fixture.launchWeb({
		apiPort,
		webPort,
		token: "fixture-workers-api-browser-token",
		cacheDir: `/tmp/eumenes-workers-ui-${webPort}`,
	});
	await fixture.ready(
		`http://127.0.0.1:${webPort}/test-fixtures/workers-ai.html`,
	);
});
test.afterAll(async () => {
	await fixture.stopAll();
});

test("register a secret, discover both speech tasks, save their selection, assign routes and reload", async ({
	page,
	request,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`http://127.0.0.1:${webPort}/test-fixtures/workers-ai.html`);
	await page.getByRole("tab", { name: "登録した接続", exact: true }).click();
	await page.screenshot({ path: "/tmp/eumenes-workers-registration.png" });
	expect(errors).toEqual([]);
	const form = page.getByRole("form", { name: "クラウドAPIを登録" });
	await form.getByLabel("接続の種類").selectOption("cloudflare-workers-ai");
	await expect(form.getByLabel(/APIのベースURL/)).toHaveCount(0);
	await form.getByLabel("接続名（必須）", { exact: true }).fill("Workers音声");
	await form
		.getByLabel("Account ID（必須）", { exact: true })
		.fill("a".repeat(32));
	await form.getByLabel(/APIキー／APIトークン/).fill("fixture-private-token");
	await page.screenshot({ path: "/tmp/eumenes-workers-registration.png" });
	await form
		.getByRole("button", { name: "クラウドAPIを登録", exact: true })
		.click();
	const save = page.getByRole("button", { name: "設定の変更をすべて保存" });
	await save.click();
	await expect(save).toBeDisabled();
	await expect(
		page
			.getByText("変更を適用しました", { exact: true })
			.filter({ visible: true })
			.first(),
	).toBeVisible();
	await expect(page.locator("body")).not.toContainText("fixture-private-token");
	expect(
		await page.evaluate(() => JSON.stringify({ ...sessionStorage })),
	).not.toContain("fixture-private-token");
	await page.getByRole("tab", { name: "音声モデル", exact: true }).click();
	await page
		.getByRole("button", { name: "接続確認・モデル一覧を更新" })
		.click();
	await expect(page.getByLabel("取得したモデル")).toBeEnabled();
	await page
		.getByLabel("取得したモデル")
		.selectOption("@cf/fixture/recognition");
	await page.getByLabel("モデルの言語").fill("ja");
	await page
		.getByRole("button", { name: "選んだモデルを下書きに追加" })
		.click();
	await page.getByLabel("モデルの用途", { exact: true }).selectOption("tts");
	await page.getByLabel("取得したモデル").selectOption("@cf/fixture/synthesis");
	await page.getByLabel("モデルの声").selectOption("voice-b");
	await page.screenshot({ path: "/tmp/eumenes-workers-models.png" });
	await page
		.getByRole("button", { name: "選んだモデルを下書きに追加" })
		.click();
	await save.click();
	await expect(save).toBeDisabled();
	const settingsUrl = `http://127.0.0.1:${apiPort}/api/settings`;
	const read = async () =>
		(
			await request.get(settingsUrl, {
				headers: { authorization: "Bearer fixture-workers-api-browser-token" },
			})
		).json();
	await expect.poll(async () => (await read()).resources.length).toBe(2);
	await page.getByRole("tab", { name: "利用するAI", exact: true }).click();
	for (const [label, purpose] of [
		["聞き取りの利用先", "asr"],
		["読み上げの利用先", "tts"],
	]) {
		await page.getByRole("button", { name: label!, exact: true }).click();
		const saved = await read();
		const resource = saved.resources.find(
			(r: { purpose: string }) => r.purpose === purpose,
		);
		await page
			.getByLabel(
				new RegExp(
					`${purpose === "asr" ? "聞き取り" : "読み上げ"}：クラウド代替先`,
				),
			)
			.selectOption(resource.id);
	}
	await save.click();
	await expect(save).toBeDisabled();
	await page.reload();
	await page.getByRole("tab", { name: "登録した接続", exact: true }).click();
	await expect(
		page
			.getByText("Workers音声", { exact: true })
			.filter({ visible: true })
			.first(),
	).toBeVisible();
	const saved = await read();
	expect(saved.connections[0].accountId).toBe("a".repeat(32));
	expect(saved.resources).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ purpose: "asr", language: "ja" }),
			expect.objectContaining({ purpose: "tts", voice: "voice-b" }),
		]),
	);
	for (const purpose of ["asr", "tts"])
		expect(saved.routes[purpose].fallbackId).toBe(
			saved.resources.find((r: { purpose: string }) => r.purpose === purpose)
				.id,
		);
	expect(errors).toEqual([]);
});
