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
	[1440, "light"],
	[1440, "dark"],
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
		expect(
			await page
				.locator(".composer-actions")
				.evaluate(
					(row) =>
						[...row.children].filter(
							(child) => getComputedStyle(child).display !== "none",
						).length,
				),
		).toBe(3);
		await expect(
			page.locator('.composer-actions > button[type="submit"]'),
		).toHaveText("送信");
		const send = await page
			.locator('.composer-actions > button[type="submit"]')
			.boundingBox();
		const actions = await page.locator(".composer-actions").boundingBox();
		expect(
			Math.abs(send!.x + send!.width - actions!.x - actions!.width),
		).toBeLessThan(2);
		await expect(
			page
				.locator(".voice-controls")
				.getByRole("group", { name: "Live音声会話" }),
		).toBeVisible();
		await page
			.locator(".chat-composer")
			.screenshot({ path: `${evidence}/composer-${width}-${theme}.png` });
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
		await expect(page.locator(".live-transcript-assistant small")).toHaveText(
			"光 · 文字起こし",
		);
		await page.getByRole("button", { name: "内容を確認しました" }).click();
		await expect(
			page.getByRole("button", { name: "内容を確認しました" }),
		).toHaveCount(0);
		await page
			.getByRole("button", { name: "音声会話の設定", exact: true })
			.click();
		await expect(
			page.getByRole("region", { name: "設定の保存" }),
		).toBeVisible();
		if (width >= 900) {
			const header = page.locator(".aui-settings-heading");
			const title = await header
				.locator(".aui-composition-title")
				.boundingBox();
			const bar = await header
				.getByRole("region", { name: "設定の保存" })
				.boundingBox();
			expect(
				Math.abs(title!.y + title!.height / 2 - bar!.y - bar!.height / 2),
			).toBeLessThan(3);
		}
		await expect(
			page.getByText(
				"見分けるための自由な名前です。例: OpenAI音声。OpenAI側のキー名と一致させる必要はありません。",
				{ exact: true },
			),
		).toBeVisible();
		await page.getByRole("tab", { name: "音声会話", exact: true }).click();
		await expect(
			page.getByLabel("音声会話を使う", { exact: true }),
		).toBeVisible();
		await expect(
			page.getByLabel("音声会話のモデル", { exact: true }),
		).toBeVisible();
		expect(
			await page
				.getByLabel("音声会話のモデル", { exact: true })
				.evaluate((node) => node.tagName),
		).toBe("SELECT");
		expect(
			await page
				.getByLabel("声の指定", { exact: true })
				.evaluate((node) => node.tagName),
		).toBe("SELECT");
		expect(
			await page
				.getByLabel("声の指定", { exact: true })
				.locator("option")
				.count(),
		).toBeGreaterThan(1);
		const model = await page
			.getByLabel("音声会話のモデル", { exact: true })
			.boundingBox();
		expect(model!.width).toBeGreaterThanOrEqual(160);
		expect(model!.x + model!.width).toBeLessThanOrEqual(width);
		const supplement = page.getByLabel("話し方の補足", { exact: true });
		expect(await supplement.evaluate((node) => node.tagName)).toBe("TEXTAREA");
		const toggleLayout = await page
			.locator('.ds-settings-field[data-control="toggle"]')
			.evaluateAll((rows) =>
				rows.map((row) => {
					const field = row.getBoundingClientRect();
					const hint = row
						.querySelector(".ds-settings-hint")
						?.getBoundingClientRect();
					const toggle = row.querySelector("input")!.getBoundingClientRect();
					return {
						width: field.width,
						hintWidth: hint?.width,
						hintHeight: hint?.height,
						rightGap: field.right - toggle.right,
					};
				}),
			);
		for (const row of toggleLayout) {
			expect(row.rightGap).toBeLessThanOrEqual(2);
			if (row.hintWidth) expect(row.hintWidth).toBeGreaterThan(row.width - 90);
			if (width >= 900 && row.hintHeight)
				expect(row.hintHeight).toBeLessThan(65);
		}
		const saveButton = await page
			.getByRole("region", { name: "設定の保存" })
			.getByRole("button", { name: "設定の変更をすべて保存", exact: true })
			.boundingBox();
		expect(saveButton!.x + saveButton!.width).toBeLessThanOrEqual(width);
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
			.locator(".toolchain-artifact")
			.screenshot({ path: `${evidence}/settings-${width}-${theme}.png` });
		await page
			.getByRole("button", { name: "音声会話を終了", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: "音声会話を開始", exact: true }),
		).toBeVisible();
	});
