import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	readdirSync,
	mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let build: string;
const evidence = "spec/verification/live-voice-2026-10-31";
test.beforeAll(() => {
	build = mkdtempSync(join(tmpdir(), "eumenes-live-ui-"));
	execFileSync(
		"bun",
		[
			"--eval",
			`import {build} from 'vite';import react from '@vitejs/plugin-react';await build({configFile:false,plugins:[react()],build:{outDir:${JSON.stringify(build)},emptyOutDir:true,rollupOptions:{input:'tests/browser/fixtures/live-voice.tsx',output:{entryFileNames:'fixture.js'}}}});`,
		],
		{ stdio: "pipe" },
	);
	mkdirSync(evidence, { recursive: true });
});
test.afterAll(() => rmSync(build, { recursive: true, force: true }));
for (const [width, theme] of [
	[900, "light"],
	[390, "light"],
	[900, "dark"],
	[390, "dark"],
] as const)
	test(`Live controls, exact subtitles and registered settings at ${width}px ${theme} without a server`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: 1000 });
		const errors: string[] = [];
		page.on("pageerror", (e) => errors.push(e.message));
		await page.route("**/*", (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path === "/")
				return route.fulfill({
					contentType: "text/html",
					body: `<!doctype html><html lang="ja" data-theme="${theme}"><meta charset="utf-8"><div id="root"></div></html>`,
				});
			const file = join(build, path.slice(1));
			try {
				return route.fulfill({
					body: readFileSync(file),
					contentType: path.endsWith(".css") ? "text/css" : "text/javascript",
				});
			} catch {
				return route.abort();
			}
		});
		await page.goto("http://localhost:28766/");
		for (const file of readdirSync(join(build, "assets")).filter((f) =>
			f.endsWith(".css"),
		))
			await page.addStyleTag({ url: `/assets/${file}` });
		await page.addScriptTag({ type: "module", url: "/fixture.js" });
		await expect(
			page.getByRole("heading", { name: "音声会話 UI fixture" }),
			errors.join("\n"),
		).toBeVisible({ timeout: 5000 });
		await page
			.getByRole("button", { name: "音声会話を開始", exact: true })
			.click();
		await expect(page.getByText("ASR: OFF", { exact: true })).toBeVisible();
		await expect(page.getByText("TTS: OFF", { exact: true })).toBeVisible();
		await expect(
			page.getByRole("button", { name: "音声を開始", exact: true }),
		).toBeDisabled();
		expect(await page.locator(".live-transcript-user p").textContent()).toBe(
			"  はい、はい  ",
		);
		await page.getByRole("button", { name: "内容を確認しました" }).click();
		await expect(
			page.getByRole("button", { name: "内容を確認しました" }),
		).toHaveCount(0);
		await page
			.getByRole("button", { name: "音声会話の設定", exact: true })
			.click();
		await expect(
			page.getByLabel("音声会話を使う", { exact: true }),
		).toBeVisible();
		await expect(
			page.getByLabel("音声会話のモデル", { exact: true }),
		).toBeVisible();
		const model = await page
			.getByLabel("音声会話のモデル", { exact: true })
			.boundingBox();
		expect(model!.width).toBeGreaterThanOrEqual(160);
		expect(
			await page
				.locator(".ds-settings-field")
				.evaluateAll((nodes) =>
					nodes.every((node) => node.scrollWidth <= node.clientWidth + 1),
				),
		).toBe(true);

		await expect(
			page.getByRole("button", { name: "音声会話を試す", exact: true }),
		).toBeDisabled();
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		).toBe(true);
		expect(errors).toEqual([]);
		await page.screenshot({
			path: `${evidence}/ui-${width}-${theme}.png`,
			fullPage: true,
		});
		await page
			.getByRole("button", { name: "音声会話を終了", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: "音声会話を開始", exact: true }),
		).toBeVisible();
	});
