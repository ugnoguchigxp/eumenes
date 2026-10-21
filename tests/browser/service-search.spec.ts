import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Browser rendering acceptance without a server or a live service session.
let directory: string;
test.beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "eumenes-service-search-ui-"));
	execFileSync(
		"bun",
		[
			"build",
			"tests/browser/service-search.fixture.tsx",
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
for (const width of [320, 960])
	test(`research progress and unverified candidate at ${width}px`, async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on("pageerror", (e) => errors.push(e.message));
		await page.setViewportSize({ width, height: 650 });
		await page.setContent(
			'<html lang="ja"><body><div id="root"></div></body></html>',
		);
		for (const file of readdirSync(directory).filter((f) => f.endsWith(".css")))
			await page.addStyleTag({
				content: readFileSync(join(directory, file), "utf8"),
			});
		await page.addStyleTag({
			content:
				"body{font-family:system-ui,sans-serif;margin:12px}.research-activity{color:#222}",
		});
		await page.addScriptTag({
			content: readFileSync(
				join(
					directory,
					readdirSync(directory).find((f) => f.endsWith(".js"))!,
				),
				"utf8",
			),
		});
		await expect(
			page.getByRole("button", { name: "調査を停止" }),
		).toBeVisible();
		await page.evaluate(async () => {
			await (
				window as unknown as {
					serviceSearchFixture: { complete(): Promise<void> };
				}
			).serviceSearchFixture.complete();
		});
		const candidate = page.getByRole("link", { name: "Python3入門動画" });
		await expect(candidate).toHaveAttribute(
			"href",
			"https://example.org/video",
		);
		await expect(candidate).toHaveCount(1);
		await expect(
			page.getByRole("list", { name: "見つかった候補" }),
		).toContainText("本文未確認");
		await expect(page.getByRole("button", { name: "調査を停止" })).toHaveCount(
			0,
		);
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth > innerWidth,
			),
		).toBe(false);
		expect(errors).toEqual([]);
		await page.screenshot({
			path: test.info().outputPath(`candidates-${width}.png`),
		});
	});
