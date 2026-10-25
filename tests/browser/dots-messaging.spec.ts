import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let directory: string;
// In-memory client fixture and real registered UI; no HTTP server or external dots.
test.beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "eumenes-dots-ui-"));
	execFileSync(
		"bun",
		[
			"build",
			"tests/browser/dots-messaging.fixture.tsx",
			"--target=browser",
			"--format=iife",
			"--define",
			"process.env={}",
			"--outdir",
			directory,
		],
		{ stdio: "pipe" },
	);
});
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));
async function open(page: Page) {
	page.on("pageerror", (e) => console.error("fixture_page_error", e.message));
	await page.setContent(
		'<html data-theme="dark"><body><main id="root" style="max-width:640px;margin:auto"></main></body></html>',
	);
	await page.evaluate(() => {
		if (!crypto.randomUUID)
			Object.defineProperty(crypto, "randomUUID", {
				value: () =>
					[1e7, 1e3, 4e3, 8e3, 1e11]
						.join("-")
						.replace(/[018]/g, (c) =>
							(Number(c) ^ ((Math.random() * 16) >> (Number(c) / 4))).toString(
								16,
							),
						),
			});
	});
	for (const f of readdirSync(directory)) {
		const content = readFileSync(join(directory, f), "utf8");
		if (f.endsWith(".css")) await page.addStyleTag({ content });
		if (f.endsWith(".js")) await page.addScriptTag({ content });
	}
	await expect(page.getByLabel("接続先", { exact: true })).toBeVisible({
		timeout: 5000,
	});
	await page.getByLabel("接続先", { exact: true }).selectOption("conn");
	await page
		.getByRole("button", { name: "メッセージ連携を有効にする" })
		.click();
}
test("explicit sends, notification-only state, summary, follow-up, cancellation and reload", async ({
	page,
}) => {
	await open(page);
	await expect(page.getByLabel("MCPサーバーURL", { exact: true })).toHaveValue(
		"https://receiver.example/mcp/dots/conn",
	);
	await expect(
		page.getByLabel("公開クライアントID", { exact: true }),
	).toHaveValue("public-test-client");
	await expect(
		page.getByRole("link", { name: "ChatGPTで接続設定を開く" }),
	).toHaveAttribute("href", "https://chatgpt.com/plugins");
	const input = page.getByLabel("dotsへのメッセージ");
	await input.fill("最初の相談");
	await page.getByRole("button", { name: "送信", exact: true }).click();
	await expect(
		page.getByText("受付済み・返答を待っています", { exact: true }),
	).toBeVisible();
	await expect(input).toHaveValue("");
	await page.evaluate(() => window.dotsMessagingTest.notifyOnly());
	await expect(
		page.getByText("通知受付済み・返答を待っています"),
	).toBeVisible();
	expect(
		await page.evaluate(() => window.dotsMessagingTest.submitted.length),
	).toBe(1);
	await page.evaluate(() => window.dotsMessagingTest.answer());
	await expect(
		page.getByText("dots からの返答", { exact: true }),
	).toBeVisible();
	await page.getByText("dots の要約", { exact: true }).click();
	await expect(page.getByText("これまでの要約")).toBeVisible();
	await expect(page.getByText("連携前の履歴は含みません")).toBeVisible();
	await input.fill("続きをお願いします");
	await page.getByRole("button", { name: "送信", exact: true }).click();
	await page.getByRole("button", { name: "送信を取り消す" }).click();
	await expect(page.getByText("取消済み", { exact: true })).toBeVisible();
	await page.evaluate(() => window.dotsMessagingTest.reload());
	await expect(page.locator("[data-fixture-generation]")).toHaveAttribute(
		"data-fixture-generation",
		"1",
	);
	await page.getByLabel("接続先", { exact: true }).selectOption("conn");
	await expect(
		page.getByText("dots からの返答", { exact: true }),
	).toBeVisible();
	await expect(page.getByText("取消済み", { exact: true })).toBeVisible();
	expect(
		await page.evaluate(() => window.dotsMessagingTest.submitted.length),
	).toBe(2);
	await page.setViewportSize({ width: 390, height: 800 });
	expect(
		await page
			.locator("main")
			.evaluate((n) => n.scrollWidth <= n.clientWidth + 1),
	).toBe(true);
	await page.screenshot({
		path: "test-results/dots-messaging.png",
		fullPage: true,
	});
});
test("expired subscription preserves draft and resubscription allows explicit sending", async ({
	page,
}) => {
	await open(page);
	const input = page.getByLabel("dotsへのメッセージ");
	await input.fill("更新後に送りたい相談");
	await page.evaluate(() => window.dotsMessagingTest.unsubscribe());
	await expect(
		page.getByText("dots 側で監視を開始・更新してください。"),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "送信", exact: true }),
	).toBeDisabled();
	await expect(input).toHaveValue("更新後に送りたい相談");
	await page.evaluate(() => window.dotsMessagingTest.resubscribe());
	await expect(
		page.getByRole("button", { name: "送信", exact: true }),
	).toBeEnabled();
	expect(
		await page.evaluate(() => window.dotsMessagingTest.submitted.length),
	).toBe(0);
	await page.getByRole("button", { name: "送信", exact: true }).click();
	await expect(
		page.getByText("更新後に送りたい相談", { exact: true }),
	).toBeVisible();
});
