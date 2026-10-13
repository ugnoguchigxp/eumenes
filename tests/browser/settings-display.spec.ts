import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture } from "./fixture";
import { createClient } from "../../client";
import { openFromLauncher } from "./artifact-launcher";

const fixture = createFixture();
const token = "settings-display-fixture-token";
const evidence = "spec/verification/settings-display-2026-10-13";
let dir: string, apiPort: number, webPort: number;
test.setTimeout(120000);
test.beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "eumenes-display-"));
	({ apiPort, webPort } = await fixture.startVoiceStack({ dir, token }));
	mkdirSync(evidence, { recursive: true });
});
test.afterAll(async () => {
	await fixture.stopAll();
	rmSync(dir, { recursive: true, force: true });
});

test("all display options preview, save, apply to the actual theme/background, reload and discard", async ({
	page,
}) => {
	const client = createClient(`http://127.0.0.1:${apiPort}`, token);
	await page.emulateMedia({ colorScheme: "light" });
	await page.goto(`http://127.0.0.1:${webPort}`);
	await expect(
		page.locator(".light-avatar-background[data-avatar-state='ready'] canvas"),
	).toBeVisible();
	await openFromLauncher(page, "設定");
	const artifact = page.getByRole("complementary", {
		name: "アーティファクト",
	});
	await artifact.getByRole("button", { name: "表示", exact: true }).click();
	const save = artifact.getByRole("button", {
		name: "設定の変更をすべて保存",
		exact: true,
	});
	await expect(save).toBeDisabled();
	await expect(artifact.getByLabel("会話の背景", { exact: true })).toHaveValue(
		"light-fairy",
	);
	const preview = artifact.locator(".subtitle-inline");
	const fairy = await page
		.locator(".light-avatar-background canvas")
		.elementHandle();
	await artifact
		.getByLabel("会話の背景", { exact: true })
		.selectOption("spatial");
	await artifact.getByLabel("テーマ", { exact: true }).selectOption("dark");
	await artifact.getByLabel("読み上げ字幕を表示する", { exact: true }).check();
	for (const style of ["netflix", "prime", "classic", "glass"]) {
		await artifact
			.getByLabel("字幕のデザイン", { exact: true })
			.selectOption(style);
		for (const [size, pixels] of [
			["medium", "22.4px"],
			["large", "28.8px"],
			["xlarge", "35.2px"],
		] as const) {
			await artifact
				.getByLabel("字幕の大きさ", { exact: true })
				.selectOption(size);
			await expect(preview).toHaveAttribute("data-style", style);
			await expect(preview).toHaveAttribute("data-size", size);
			await expect(preview.locator("p")).toHaveCSS("font-size", pixels);
		}
		if (style === "classic")
			await expect(preview.locator("p")).toHaveCSS(
				"color",
				"rgb(255, 228, 92)",
			);
		else
			await expect(preview.locator("p")).toHaveCSS(
				"color",
				"rgb(255, 255, 255)",
			);
		if (style === "prime")
			await expect(preview.locator("p")).toHaveCSS(
				"background-color",
				"rgba(0, 0, 0, 0.72)",
			);
		if (style === "netflix" || style === "classic")
			await expect(preview.locator("p")).not.toHaveCSS("text-shadow", "none");
	}
	await expect(preview.locator("p")).toHaveCSS("backdrop-filter", "blur(12px)");
	// The preview uses draft values; saved preferences and the conversation still use the old values.
	expect((await client.settings()).general.theme).toBe("system");
	await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
	await expect(page.locator(".spatial-background")).toHaveCount(0);
	await artifact.getByRole("button", { name: "変更一覧を開く" }).click();
	for (const label of [
		"会話の背景",
		"テーマ",
		"読み上げ字幕を表示する",
		"字幕のデザイン",
		"字幕の大きさ",
	])
		await expect(
			artifact.getByText("表示 / " + label, { exact: true }),
		).toBeVisible();
	await expect(
		artifact.getByText("既存の設定画面の変更", { exact: true }),
	).toHaveCount(0);
	await artifact.getByRole("tab", { name: "表示", exact: true }).click();
	await save.click();
	await expect(
		artifact.getByText("変更を適用しました", { exact: true }),
	).toBeVisible();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	await expect(
		page.locator(".spatial-background[data-background-state='ready'] canvas"),
	).toBeVisible();
	expect(await fairy!.evaluate((canvas) => canvas.isConnected)).toBe(false);
	expect((await client.settings()).general).toMatchObject({
		theme: "dark",
		background: "spatial",
		subtitles: { enabled: true, style: "glass", size: "xlarge" },
	});
	await page.setViewportSize({ width: 1280, height: 1400 });
	await artifact.locator(".ds-settings-panel").scrollIntoViewIfNeeded();
	await artifact.screenshot({ path: join(evidence, "display-saved.png") });
	await page.setViewportSize({ width: 1280, height: 720 });
	await page.reload();
	await openFromLauncher(page, "設定");
	await artifact.getByRole("button", { name: "表示", exact: true }).click();
	await expect(
		artifact.getByLabel("字幕のデザイン", { exact: true }),
	).toHaveValue("glass");
	await expect(
		artifact.getByLabel("字幕の大きさ", { exact: true }),
	).toHaveValue("xlarge");
	await expect(
		artifact.getByLabel("読み上げ字幕を表示する", { exact: true }),
	).toBeChecked();
	await expect(artifact.getByLabel("テーマ", { exact: true })).toHaveValue(
		"dark",
	);
	await expect(artifact.getByLabel("会話の背景", { exact: true })).toHaveValue(
		"spatial",
	);
	await artifact.getByLabel("テーマ", { exact: true }).selectOption("light");
	await save.click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
	await artifact.getByLabel("テーマ", { exact: true }).selectOption("system");
	await save.click();
	await page.emulateMedia({ colorScheme: "dark" });
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	await page.emulateMedia({ colorScheme: "light" });
	await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
	const spatial = await page
		.locator(".spatial-background canvas")
		.elementHandle();
	await artifact
		.getByLabel("会話の背景", { exact: true })
		.selectOption("light-fairy");
	await save.click();
	await expect(
		page.locator(".light-avatar-background[data-avatar-state='ready'] canvas"),
	).toBeVisible();
	expect(await spatial!.evaluate((canvas) => canvas.isConnected)).toBe(false);
	await artifact.getByLabel("テーマ", { exact: true }).selectOption("dark");
	await artifact
		.getByRole("button", { name: "表示を閉じる", exact: true })
		.click();
	await artifact.getByRole("tab", { name: "設定", exact: true }).click();
	await artifact.getByRole("button", { name: "表示", exact: true }).click();
	await expect(artifact.getByLabel("テーマ", { exact: true })).toHaveValue(
		"dark",
	);
	await artifact.getByRole("button", { name: "変更一覧を開く" }).click();
	await artifact
		.getByRole("button", { name: "未適用の設定変更をすべて破棄" })
		.click();
	await artifact.getByRole("tab", { name: "表示", exact: true }).click();
	await expect(artifact.getByLabel("テーマ", { exact: true })).toHaveValue(
		"system",
	);
	await page.setViewportSize({ width: 390, height: 844 });
	await save.scrollIntoViewIfNeeded();
	await expect(save).toBeInViewport();
	await artifact.screenshot({ path: join(evidence, "display-narrow.png") });
});

test("saved subtitle enablement, design and size are applied to speech overlays", async ({
	page,
}) => {
	await page.goto(`http://127.0.0.1:${webPort}`);
	await openFromLauncher(page, "設定");
	const artifact = page.getByRole("complementary", {
		name: "アーティファクト",
	});
	await artifact.getByRole("button", { name: "表示", exact: true }).click();
	await artifact.getByLabel("読み上げ字幕を表示する", { exact: true }).check();
	await artifact
		.getByLabel("字幕のデザイン", { exact: true })
		.selectOption("prime");
	await artifact
		.getByLabel("字幕の大きさ", { exact: true })
		.selectOption("medium");
	await artifact
		.getByRole("button", { name: "設定の変更をすべて保存", exact: true })
		.click();
	await expect(
		artifact.getByText("変更を適用しました", { exact: true }),
	).toBeVisible();
	await page
		.getByRole("textbox", { name: "メッセージ", exact: true })
		.fill("表示設定の動作確認です。");
	await page.getByRole("button", { name: "送信", exact: true }).click();
	const subtitle = page.locator(".subtitle:not(.subtitle-inline)");
	await expect(subtitle).toBeVisible();
	await expect(subtitle).toHaveAttribute("data-style", "prime");
	await expect(subtitle).toHaveAttribute("data-size", "medium");
	await expect(subtitle.locator("p")).toHaveCSS("font-size", "24px");
	await expect(subtitle).toContainText("承知しました。");
	await page
		.getByRole("button", { name: "読み上げを停止", exact: true })
		.click();
	await expect(subtitle).toHaveCount(0);
	await artifact
		.getByLabel("読み上げ字幕を表示する", { exact: true })
		.uncheck();
	await artifact
		.getByRole("button", { name: "設定の変更をすべて保存", exact: true })
		.click();
	await expect(
		artifact.getByText("変更を適用しました", { exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "読み上げ直す", exact: true })
		.last()
		.click();
	await expect(
		page.getByRole("button", { name: "読み上げを停止", exact: true }),
	).toBeVisible();
	await expect(subtitle).toHaveCount(0);
	await page
		.getByRole("button", { name: "読み上げを停止", exact: true })
		.click();
});
