import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Component acceptance in the real ArtifactPanel; no HTTP server or live Brave session.
let directory: string;
test.beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "eumenes-browser-components-"));
	execFileSync(
		"bun",
		[
			"build",
			"tests/browser/browser-workspace.fixture.tsx",
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
for (const width of [320, 420, 700])
	test(`Script, progress and settings inside the ${width}px artifact`, async ({
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
			content: `html,body,#root{margin:0;height:100%;}body{font-family:system-ui,sans-serif;color:var(--foreground);background:var(--background)}.artifact-panel{display:grid;grid-template-rows:auto minmax(0,1fr);height:100%;min-width:0}.artifact-panel-header{padding:8px;border-bottom:1px solid var(--border)}.artifact-panel-body{padding:12px;overflow:auto;min-width:0;min-height:0}.artifact-panel-body[hidden]{display:none}`,
		});
		const js = readdirSync(directory).find((f) => f.endsWith(".js"))!;
		await page.addScriptTag({
			content: readFileSync(join(directory, js), "utf8"),
		});
		expect(errors).toEqual([]);
		const panel = page.getByRole("complementary", { name: "アーティファクト" });
		await expect(
			panel.getByRole("region", { name: "実行Script" }),
		).toBeVisible();
		await expect(panel.getByRole("textbox")).toHaveCount(0);
		await expect(
			panel.getByRole("region", { name: "撮影した画像" }),
		).toHaveCount(0);
		await panel.screenshot({
			path: test.info().outputPath(`artifact-${width}.png`),
		});
		await panel
			.getByRole("combobox", { name: "表示する作業" })
			.selectOption("k2");
		await page.evaluate(() => window.browserFixture.update());
		await expect(
			panel.getByRole("combobox", { name: "表示する作業" }),
		).toHaveValue("k2");
		await expect(
			panel.getByText("結果不明", { exact: true }).first(),
		).toBeVisible();
		await panel.getByRole("tab", { name: "接続・タブ", exact: true }).click();
		await expect(
			panel.getByRole("region", { name: "タブ", exact: true }),
		).toBeVisible();
		await expect(panel.getByLabel("Braveの実行ファイルのパス")).toBeHidden();
		await panel.getByRole("button", { name: "設定", exact: true }).click();
		await expect(
			panel.getByRole("region", { name: "ブラウザの設定" }),
		).toBeVisible();
		const token = panel.getByLabel("接続トークン", { exact: true });
		await expect(token).toHaveValue("");
		await panel.screenshot({
			path: test.info().outputPath(`settings-${width}.png`),
		});
		await token.fill("fixture-write-only-token");
		await panel.getByRole("button", { name: "承認の設定を保存" }).click();
		await expect(token).toHaveValue("");
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth > innerWidth,
			),
		).toBe(false);
		expect(await page.evaluate(() => window.browserFixture.actions)).toContain(
			"browser-bridge-save",
		);
	});
