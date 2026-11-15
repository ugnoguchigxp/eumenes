import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunProgress } from "../../api/domains/dialogue/contracts";

test.use({ launchOptions: { args: ["--mute-audio"] } });
let directory: string;
test.beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "eumenes-conversation-stream-"));
	execFileSync(
		"bun",
		[
			"build",
			"tests/browser/conversation-stream.fixture.tsx",
			"--target=browser",
			"--format=iife",
			'--define=process.env={"NODE_ENV":"production"}',
			"--outdir",
			directory,
		],
		{ stdio: "pipe" },
	);
});
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));
test.beforeEach(async ({ page }) => {
	await page.route("http://127.0.0.1:18709/**", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: '<html lang="ja"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>',
		}),
	);
	await page.goto("http://127.0.0.1:18709/fixture");
	await page.addStyleTag({
		content:
			"body{font:16px sans-serif;background:#fafafa;color:#222}main{max-width:720px;margin:40px auto}.message{padding:16px;margin:16px 0;background:white;border:1px solid #ddd;border-radius:12px}.message-user{background:#eef4ff}.message small{color:#666}.visually-hidden{position:absolute;clip-path:inset(50%);width:1px;height:1px;overflow:hidden}",
	});
	await page.addScriptTag({
		content: readFileSync(
			join(directory, "conversation-stream.fixture.js"),
			"utf8",
		),
	});
	await expect
		.poll(() => page.evaluate(() => window.conversationStreamFixture?.count()))
		.toBe(1);
});
const frame = (
	text: string,
	sequence = 1,
	generationId = "first",
): RunProgress => ({
	runId: "run",
	status: "running",
	text,
	provisional: { generationId, sequence },
});
const send = (page: Page, value: RunProgress, index = 0) =>
	page.evaluate(
		({ value, index }) => window.conversationStreamFixture.send(index, value),
		{ value, index },
	);

test("shows text before completion, replaces generations, then displays the adopted answer exactly once", async ({
	page,
}) => {
	await send(page, frame("生成途中の本文です。"));
	await expect(page.locator('[aria-busy="true"]')).toContainText(
		"生成途中の本文です。",
	);
	await page.screenshot({
		path: test.info().outputPath("streaming.png"),
		fullPage: true,
	});
	await send(page, frame("生成途中の本文です。続きです。", 2));
	await send(page, frame("古い本文", 1));
	await expect(page.locator('[aria-busy="true"]')).toContainText("続きです。");
	await send(page, frame("", 0, "second"));
	await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
	await send(page, frame("新しい生成です。", 1, "second"));
	await send(page, frame("遅い古い生成", 3));
	await expect(page.locator('[aria-busy="true"]')).toContainText(
		"新しい生成です。",
	);
	await send(page, {
		runId: "run",
		status: "completed",
		text: "採用された回答です。",
		provisional: null,
	});
	await page.evaluate(() =>
		window.conversationStreamFixture.adopt("採用された回答です。"),
	);
	await expect(page.locator("article.message-assistant")).toHaveCount(1);
	await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
	await expect(page.locator("article.message-assistant")).toContainText(
		"採用された回答です。",
	);
	await page.screenshot({
		path: test.info().outputPath("adopted.png"),
		fullPage: true,
	});
});

for (const status of ["cancelled", "failed"] as const) {
	test(`${status} removes the visible draft and a late frame cannot restore it`, async ({
		page,
	}) => {
		await send(page, frame("破棄される途中の内容です。"));
		await expect(page.locator('[aria-busy="true"]')).toContainText(
			"破棄される途中の内容です。",
		);
		await send(page, { runId: "run", status, text: "", provisional: null });
		await expect(page.locator("article.message-assistant")).toHaveCount(0);
		await send(page, frame("遅れて届いた内容", 2));
		await expect(page.getByText(/破棄される|遅れて届いた/)).toHaveCount(0);
		await page.screenshot({
			path: test.info().outputPath(`${status}.png`),
			fullPage: true,
		});
	});
}

test("disconnect clears the draft before reconnect and only the current stream is displayed", async ({
	page,
}) => {
	await send(page, frame("切断前の内容です。"));
	await expect(page.locator('[aria-busy="true"]')).toContainText(
		"切断前の内容です。",
	);
	await page.evaluate(() => window.conversationStreamFixture.disconnect(0));
	await expect(page.locator("article.message-assistant")).toHaveCount(0);
	await expect
		.poll(() => page.evaluate(() => window.conversationStreamFixture.count()))
		.toBe(2);
	await send(page, frame("遅い旧接続", 2), 0);
	await send(
		page,
		{ runId: "run", status: "running", text: "", provisional: null },
		1,
	);
	await expect(page.locator("article.message-assistant")).toHaveCount(0);
	await send(page, frame("再接続後の内容です。", 5, "second"), 1);
	await expect(page.locator('[aria-busy="true"]')).toContainText(
		"再接続後の内容です。",
	);
});
