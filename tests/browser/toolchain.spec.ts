import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createFixture } from "./fixture";
import { evidencePath } from "./evidence";

test.setTimeout(60000);
const fixture = createFixture();
let webPort: number;
test.beforeAll(async () => {
	const [apiPort, web] = (await fixture.ports(2)) as [number, number];
	webPort = web;
	await fixture.launch(
		["scripts/toolchain-fixture-server.ts"],
		{
			EUMENES_PORT: String(apiPort),
			EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
		},
		{ ports: [apiPort] },
	);
	await fixture.ready(`http://127.0.0.1:${apiPort}/api/status`);
	await fixture.launchWeb({
		webPort,
		apiPort,
		token: "fixture-token-for-toolchain-browser",
		cacheDir: `/tmp/eumenes-toolchain-vite-${webPort}`,
	});
	await fixture.ready(`http://127.0.0.1:${webPort}`);
});
test.afterAll(() => fixture.stopAll());
for (const [question, answer] of [
	["東京の天気を調べて", "26度"],
	["AAPLの株価を調べて", "250.12"],
])
	test(`browser → API → child → web → summary → main: ${question}`, async ({
		page,
	}) => {
		await page.goto(`http://127.0.0.1:${webPort}`);
		await expect(page.getByText(/接続済み/)).toBeVisible({ timeout: 20000 });
		await page.getByRole("textbox").fill(question!);
		const submission = page.waitForResponse(
			(r) => r.url().endsWith("/api/runs") && r.request().method() === "POST",
		);
		await page.getByRole("button", { name: "送信", exact: true }).click();
		const response = await submission;
		expect(response.status()).toBe(202);
		const body = await response.json();
		expect(body.id).toBeTruthy();
		await expect(page.getByRole("textbox")).toHaveValue("");
		const card = page.getByRole("complementary", { name: `調査: ${question}` });
		await expect(card).toBeVisible({ timeout: 20000 });
		await expect(page.locator(".message .research-activity")).toHaveCount(0);
		await expect(card.locator(".message-author")).toHaveCount(0);
		await expect(card).not.toContainText(question!);
		await expect(card.locator("details")).toHaveAttribute("open", "");
		await expect(card).toContainText(answer!, { timeout: 20000 });
		await expect(card.getByRole("link", { name: "一次資料" })).toHaveAttribute(
			"href",
			/https:\/\/example.com\//,
		);
		await expect(page.locator(".message-assistant").last()).toContainText(
			answer!,
		);

		const answerBubble = page.locator(".message-assistant").last();
		const sourceLink = answerBubble.getByRole("link", { name: "example.com" });
		await expect(sourceLink).toHaveAttribute("target", "_blank");
		await expect(sourceLink).toHaveAttribute("href", /https:\/\/example.com\//);
		if (question === "東京の天気を調べて") {
			await expect(answerBubble).toContainText("最低17度");
			await expect(answerBubble).toContainText("降水確率0％");
		}
		await expect(page.locator("body")).not.toContainText("INJECTION_SENTINEL");
		await page.reload();
		await expect(page.getByText(/接続済み/)).toBeVisible({ timeout: 20000 });
		await expect(card).toContainText(answer!, { timeout: 20000 });
		await expect(card.locator("details")).toHaveAttribute("open", "");
		if (question === "東京の天気を調べて") {
			mkdirSync(evidencePath("research-activity"), { recursive: true });
			await page.screenshot({
				path: evidencePath("research-activity/desktop.png"),
			});
			await page.setViewportSize({ width: 390, height: 844 });
			await expect(card).toBeVisible();
			expect(
				await card.evaluate((el) => el.getBoundingClientRect().right),
			).toBeLessThanOrEqual(390);
			await page.screenshot({
				path: evidencePath("research-activity/mobile.png"),
			});
		}
	});
