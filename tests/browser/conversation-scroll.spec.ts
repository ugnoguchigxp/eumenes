import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.use({ launchOptions: { args: ["--mute-audio"] } });
let directory: string;
let pageErrors: string[];
test.beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "eumenes-chat-scroll-"));
	execFileSync(
		"bun",
		[
			"build",
			"tests/browser/conversation-scroll.fixture.tsx",
			"--target=browser",
			"--format=iife",
			'--define=process.env={"NODE_ENV":"development"}',
			"--outdir",
			directory,
		],
		{ stdio: "pipe" },
	);
});
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));
test.beforeEach(async ({ page }) => {
	pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.route("http://127.0.0.1/__scroll_fixture__", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: '<html lang="ja"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>',
		}),
	);
	await page.goto("http://127.0.0.1/__scroll_fixture__");
	await page.addStyleTag({
		content:
			readFileSync(join(directory, "conversation-scroll.fixture.css"), "utf8") +
			":root{--background:#f8fafc;--foreground:#172033;--card:#fff;--border:#cbd5e1;--primary:#2563eb;--muted-foreground:#64748b}",
	});
	await page.addScriptTag({
		content: readFileSync(
			join(directory, "conversation-scroll.fixture.js"),
			"utf8",
		),
	});
	await expect(page.locator("article.message")).toHaveCount(20);
	await bottom(page);
});
test.afterEach(() => expect(pageErrors).toEqual([]));
const gap = (page: Page) =>
	page
		.locator(".chat-history")
		.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
const bottom = (page: Page) =>
	expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
const frames = (page: Page) =>
	page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
const up = async (page: Page, distance: number) => {
	await page.locator(".chat-history").hover();
	await page.mouse.wheel(0, -distance);
	await expect(
		page.getByRole("button", { name: "最新の発言へ ↓" }),
	).toBeVisible();
};
const anchor = (page: Page, position?: number) =>
	page.locator(".chat-history").evaluate((root, position) => {
		if (position !== undefined) root.scrollTop = position;
		const top = root.getBoundingClientRect().top;
		const row = Array.from(root.querySelectorAll("article.message")).find(
			(node) => node.getBoundingClientRect().top >= top,
		)!;
		return {
			text: row.querySelector("p")!.textContent,
			top: row.getBoundingClientRect().top,
		};
	}, position);

test("latest position follows streaming, delayed height, and viewport changes without stealing input focus", async ({
	page,
}) => {
	await page
		.getByRole("textbox", { name: "メッセージ" })
		.fill("入力中の下書き");
	await page.evaluate(() =>
		window.conversationScrollFixture.stream("回答\n".repeat(80)),
	);
	await bottom(page);
	await page.evaluate(() => window.conversationScrollFixture.grow());
	await frames(page);
	await bottom(page);
	await page.setViewportSize({ width: 390, height: 640 });
	await bottom(page);
	await expect(page.getByRole("textbox", { name: "メッセージ" })).toBeFocused();
	await page.screenshot({ path: test.info().outputPath("latest-mobile.png") });
});

test("even a small upward scroll pauses following, preserves the reading position during new messages, and resumes at the bottom", async ({
	page,
}) => {
	await up(page, 36);
	const before = await anchor(page);
	await page.evaluate(() => {
		window.conversationScrollFixture.append();
		window.conversationScrollFixture.stream("更新中\n".repeat(20));
	});
	await frames(page);
	expect(await anchor(page)).toEqual(before);
	await page.evaluate(() => window.conversationScrollFixture.grow());
	await frames(page);
	expect(await anchor(page)).toEqual(before);
	await page.locator(".chat-history").evaluate((node) => {
		node.scrollTop = node.scrollHeight;
	});
	await expect(
		page.getByRole("button", { name: "最新の発言へ ↓" }),
	).toHaveCount(0);
	await page.evaluate(() => window.conversationScrollFixture.grow());
	await bottom(page);
});

test("scrolling to older history adds one page without moving the visible messages; latest restores the bounded window", async ({
	page,
}) => {
	await up(page, 400);
	const heightBefore = await page
		.locator(".messages")
		.evaluate((node) => node.getBoundingClientRect().height);
	const before = await anchor(page, 100);
	await expect(page.locator("article.message")).toHaveCount(40);
	const addedHeight =
		(await page
			.locator(".messages")
			.evaluate((node) => node.getBoundingClientRect().height)) - heightBefore;
	// This Chromium fixture rounds scrollTop to whole CSS pixels (measured at DPR 1).
	// Verify the exact compensated scroll position and its unavoidable rounding residue.
	const requestedTop = 100 + addedHeight;
	expect(
		await page.locator(".chat-history").evaluate((node) => node.scrollTop),
	).toBe(Math.round(requestedTop));
	const after = await anchor(page);
	expect(after).toEqual({
		text: before.text,
		top: before.top + requestedTop - Math.round(requestedTop),
	});
	await page.evaluate(() => window.conversationScrollFixture.append());
	await frames(page);
	expect(await anchor(page)).toEqual(after);
	await page.screenshot({ path: test.info().outputPath("history.png") });
	await page.getByRole("button", { name: "最新の発言へ ↓" }).click();
	await expect(page.locator("article.message")).toHaveCount(20);
	await bottom(page);
});

test("one upward gesture reaching the top loads older messages without a second gesture", async ({
	page,
}) => {
	await up(page, 100000);
	await expect(page.locator("article.message")).toHaveCount(40);
	await expect(page.getByText("発言 960", { exact: false })).toBeVisible();
});

test("keyboard history navigation pauses following and the explicit latest action resumes it", async ({
	page,
}) => {
	await page.locator(".chat-history").focus();
	await page.keyboard.press("PageUp");
	await expect(
		page.getByRole("button", { name: "最新の発言へ ↓" }),
	).toBeVisible();
	await page.evaluate(() =>
		window.conversationScrollFixture.stream("別の更新\n".repeat(20)),
	);
	await frames(page);
	expect(await gap(page)).toBeGreaterThan(100);
	await page.getByRole("button", { name: "最新の発言へ ↓" }).click();
	await bottom(page);
});
