import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let build: string;
test.beforeAll(() => {
	build = mkdtempSync(join(tmpdir(), "eumenes-research-note-ui-"));
	execFileSync(
		"bun",
		[
			"build",
			"tests/browser/research-note.fixture.tsx",
			"--target=browser",
			"--format=esm",
			"--minify",
			"--define",
			'process.env.NODE_ENV="production"',
			`--outdir=${build}`,
		],
		{ stdio: "pipe" },
	);
});
test.afterAll(() => rmSync(build, { recursive: true, force: true }));

test("a long research note renders its tail and sources, and exports them after an edit", async ({
	page,
	context,
}) => {
	page.on("pageerror", (error) => {
		throw error;
	});
	// Route the page in memory: this fixture starts no backend or web server.
	await context.route("**/*", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: '<!doctype html><html lang="ja" data-theme="dark"><meta charset="utf-8"><div id="root"></div></html>',
		}),
	);
	await page.goto("http://research-note.test/");
	await page.addStyleTag({
		content: readFileSync(join(build, "research-note.fixture.css"), "utf8"),
	});
	await page.addScriptTag({
		path: join(build, "research-note.fixture.js"),
		type: "module",
	});
	const body = page.getByLabel("文書本文", { exact: true });
	await expect(body).toContainText("末尾の留保: 地域ごとの条件は未確認。");
	await expect(page.getByRole("link", { name: "一次資料" })).toHaveAttribute(
		"href",
		"https://example.com/original",
	);
	await body.click();
	await page.keyboard.press("ControlOrMeta+End");
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("Enter");
	await page.keyboard.insertText("追記した条件。");
	await expect(body).toContainText("追記した条件。");
	const pending = page.waitForEvent("download");
	await page.getByRole("button", { name: "Markdownをダウンロード" }).click();
	const download = await pending;
	expect(download.suggestedFilename()).toBe("調査メモ.md");
	const exported = readFileSync((await download.path())!, "utf8");
	expect(exported.length).toBeGreaterThan(8000);
	expect(exported).toContain("末尾の留保: 地域ごとの条件は未確認。");
	expect(exported).toContain("https://example.com/original");
	expect(exported).toContain("追記した条件。");
	expect(exported.startsWith("---")).toBe(false);
});
