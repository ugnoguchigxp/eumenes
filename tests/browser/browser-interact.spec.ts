import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
let directory: string;
test.beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "interact-ui-browser-"));
	execFileSync(
		"bun",
		[
			"build",
			"tests/browser/browser-interact.fixture.tsx",
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
for (const width of [320, 700])
	test(`pilot controls retain question identity and do not carry confirmation to another run at ${width}px`, async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on("pageerror", (e) => errors.push(e.message));
		await page.setViewportSize({ width, height: 1000 });
		await page.setContent(
			'<html lang="ja"><body><div id="root"></div></body></html>',
		);
		await page.evaluate((id) => {
			if (!crypto.randomUUID)
				Object.defineProperty(crypto, "randomUUID", { value: () => id });
		}, randomUUID());
		for (const file of readdirSync(directory).filter((f) => f.endsWith(".css")))
			await page.addStyleTag({
				content: readFileSync(join(directory, file), "utf8"),
			});
		await page.addStyleTag({
			content:
				"html,body,#root{margin:0;height:100%;}body{font-family:system-ui,sans-serif;color:var(--foreground);background:var(--background)}.artifact-panel{display:grid;grid-template-rows:auto minmax(0,1fr);height:100%;min-width:0}.artifact-panel-header{padding:8px}.artifact-panel-body{padding:12px;overflow:auto;min-width:0;min-height:0}.artifact-panel-body[hidden]{display:none}",
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
			page.getByText("撮影を保存すると、ここに表示します。").first(),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "作業を始める" }),
		).toBeVisible();
		await page.getByLabel("依頼内容", { exact: false }).fill("依頼内容の原文");
		await page
			.getByLabel("開始するURL", { exact: false })
			.fill("https://example.com/");
		await page.getByRole("button", { name: "作業を始める" }).click();
		await expect
			.poll(() => page.evaluate(() => window.interactFixture.events[0]?.values))
			.toEqual({
				request: "依頼内容の原文",
				url: "https://example.com/",
				conversationId: "main",
			});
		await page.getByRole("radio", { name: "実行する", exact: true }).check();
		await page.evaluate(() => window.interactFixture.nextQuestion());
		await expect(
			page.getByRole("radio", { name: "実行する", exact: true }),
		).not.toBeChecked();
		await page.getByRole("radio", { name: "実行しない", exact: true }).check();
		await page.getByRole("button", { name: "選択を送る" }).click();
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						window.interactFixture.events.find((e) => e.source === "reply")
							?.values,
				),
			)
			.toMatchObject({
				questionId: "q2",
				generation: "2",
				expectedRevision: "3",
				decision: "deny",
			});
		const forget = page.getByRole("checkbox", {
			name: "この作業と保存した撮影を削除する",
		});
		await forget.check();
		await page.evaluate(() => window.interactFixture.nextRun());
		await expect(forget).not.toBeChecked();
		await page.evaluate(() => window.interactFixture.parent());
		await expect(
			page.getByRole("button", { name: "選択を送る" }),
		).toBeDisabled();
		await expect(
			page.getByRole("button", { name: "この作業と撮影を削除" }),
		).toBeDisabled();
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth > innerWidth,
			),
		).toBe(false);
		expect(errors).toEqual([]);
		await page.screenshot({
			path: test.info().outputPath(`interact-${width}.png`),
			fullPage: true,
		});
	});
