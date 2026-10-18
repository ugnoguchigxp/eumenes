import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// No HTTP server, backend, credentials or live provider is used by this component acceptance.
let directory: string;
test.beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "eumenes-model3d-components-"));
	execFileSync(
		"bun",
		[
			"build",
			"tests/browser/model3d-components.fixture.tsx",
			"--target=browser",
			"--format=iife",
			"--outdir",
			directory,
		],
		{ stdio: "pipe" },
	);
});
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function open(page: Page, mode = "model3d") {
	await page.setContent(
		`<html data-theme="dark"><body data-fixture="${mode}"><div id="root"></div></body></html>`,
	);
	for (const name of readdirSync(directory).filter((file) =>
		file.endsWith(".css"),
	)) {
		await page.addStyleTag({
			content: readFileSync(join(directory, name), "utf8"),
		});
	}
	await page.addStyleTag({
		content: `
        html,body,#root { margin:0; height:100%; overflow:hidden; }
        body { color:var(--foreground); background:var(--background); }
        .workspace-layout { display:grid; height:100dvh; min-height:0; }
        .chat-panel { min-width:0; padding:1rem; overflow:auto; }
        .artifact-panel { min-width:0; min-height:0; display:grid; grid-template-rows:auto minmax(0,1fr); }
        .artifact-panel-header { padding:.5rem; border-bottom:1px solid var(--border); }
        .artifact-panel-body { padding:8px; overflow:auto; min-width:0; min-height:0; }
    `,
	});
	const js = readdirSync(directory).find((file) => file.endsWith(".js"))!;
	await page.addScriptTag({
		content: readFileSync(join(directory, js), "utf8"),
	});
	await expect(
		mode === "gallery"
			? page.getByRole("region", { name: "生成した画像" })
			: page.getByRole("form", { name: "3Dモデルの生成" }),
	).toBeVisible();
}

test("shared image grid preserves the image studio's modal preview, download and confirmed deletion", async ({
	page,
}) => {
	await open(page, "gallery");
	await expect(page.locator(".image-gallery-card")).toHaveCount(1);
	await expect(page.locator(".image-gallery-thumbnail img")).toBeVisible();
	await expect(
		page.getByRole("link", { name: "保存画像をダウンロード" }),
	).toBeVisible();
	await page.getByRole("button", { name: "保存画像を表示" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByRole("img", { name: "保存画像" })).toBeVisible();
	for (const width of [390, 1300]) {
		await page.setViewportSize({ width, height: 700 });
		const fit = await dialog.evaluate((node) => {
			const box = node.getBoundingClientRect();
			const image = node.querySelector("img")!.getBoundingClientRect();
			return (
				node.scrollWidth <= node.clientWidth &&
				node.scrollHeight <= node.clientHeight &&
				image.left >= box.left &&
				image.right <= box.right &&
				image.top >= box.top &&
				image.bottom <= box.bottom
			);
		});
		expect(fit).toBe(true);
	}
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "保存画像を削除" }).click();
	await expect(
		page.getByRole("dialog", { name: "画像を削除しますか？" }),
	).toBeVisible();
	await page.getByRole("button", { name: "キャンセル", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "保存画像を表示" }),
	).toBeVisible();
});

test("model grid renders real GLB thumbnails only on visible cards, opens detail and restores list position", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1300, height: 800 });
	await open(page);
	await page.getByRole("tab", { name: "ライブラリ" }).click();
	const body = page.locator(".artifact-panel-body");
	const thumbnails = page.locator(".model3d-thumbnail > img");
	await expect(thumbnails.first()).toBeVisible();
	const firstImage = thumbnails.first();
	const capture = await firstImage.evaluate(async (element) => {
		const image = element as HTMLImageElement;
		await image.decode();
		const canvas = document.createElement("canvas");
		canvas.width = image.naturalWidth;
		canvas.height = image.naturalHeight;
		const context = canvas.getContext("2d")!;
		context.drawImage(image, 0, 0);
		const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
		const colors = new Set<string>();
		for (let i = 0; i < pixels.length; i += 16)
			colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
		return {
			width: image.naturalWidth,
			height: image.naturalHeight,
			colors: colors.size,
		};
	});
	expect(capture).toMatchObject({ width: 256, height: 256 });
	expect(capture.colors).toBeGreaterThan(10);
	const stats = await page.evaluate(
		() =>
			(window as unknown as { model3dTest: { loads: number; peak: number } })
				.model3dTest,
	);
	expect(stats.loads).toBeLessThan(18);
	expect(stats.peak).toBe(1);
	await page.getByRole("textbox", { name: "検索" }).fill("入力途中の検索");
	await page
		.getByRole("button", { name: "モデル7を開く", exact: true })
		.scrollIntoViewIfNeeded();
	const before = await body.evaluate((node) => node.scrollTop);
	expect(before).toBeGreaterThan(0);
	await page
		.getByRole("button", { name: "モデル7を開く", exact: true })
		.click();
	await expect(
		page.getByRole("region", { name: "モデルの拡大詳細" }),
	).toBeVisible();
	await expect(page.locator(".model3d-viewer-frame canvas")).toBeVisible();
	await expect(page.getByRole("search")).not.toBeVisible();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await page.getByRole("button", { name: "一覧に戻る" }).click();
	await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBe(before);
	await expect(page.getByRole("textbox", { name: "検索" })).toHaveValue(
		"入力途中の検索",
	);
	await expect(
		page.getByRole("button", { name: "モデル7を開く", exact: true }),
	).toBeFocused();
	await expect(
		page
			.locator(".model3d-results li")
			.filter({
				has: page.getByRole("button", { name: "モデル7を開く", exact: true }),
			})
			.locator(".model3d-thumbnail > img"),
	).toBeVisible();
	for (const width of [320, 440, 640, 960]) {
		await page.locator(".artifact-panel").evaluate((node, size) => {
			(node as HTMLElement).style.width = `${size}px`;
		}, width);
		expect(
			await body.evaluate((node) => node.scrollWidth > node.clientWidth + 1),
		).toBe(false);
	}
	await page.locator(".artifact-panel").evaluate((node) => {
		(node as HTMLElement).style.width = "";
	});
	await page.screenshot({ path: "test-results/model3d-grid.png" });
});

test("narrow and stacked artifacts keep their content contained and image selection preserves the draft", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1300, height: 800 });
	await open(page);
	await page
		.getByRole("textbox", { name: "タイトル" })
		.fill("入力途中のタイトル");
	await page.getByRole("textbox", { name: "作りたいもの" }).fill("残す文章");
	await page.getByLabel("保存した画像から作る").check();
	await page.getByRole("button", { name: "画像を選ぶ", exact: true }).click();
	await expect(page.locator(".image-picker").getByRole("tab")).toHaveCount(2);
	await page.getByRole("tab", { name: "Googleフォト", exact: true }).click();
	await expect(
		page.getByText("Googleフォトからの選択は未実装です。", { exact: false }),
	).toBeVisible();
	const chooser = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "参照…", exact: true }).click();
	const imageData = await page.evaluate(() => {
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 32;
		canvas.getContext("2d")!.fillRect(0, 0, 32, 32);
		return canvas.toDataURL("image/png").split(",")[1];
	});
	await (
		await chooser
	).setFiles({
		name: "upload.png",
		mimeType: "image/png",
		buffer: Buffer.from(imageData, "base64"),
	});
	await expect(page.getByRole("img", { name: "upload.png" })).toBeVisible();
	await expect
		.poll(() =>
			page
				.getByRole("img", { name: "upload.png" })
				.evaluate((node) => (node as HTMLImageElement).naturalWidth),
		)
		.toBe(32);
	await expect(
		page.getByText("upload.png：未アップロード。", { exact: false }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "この画像を使う" }),
	).toBeDisabled();
	await page.getByRole("tab", { name: "LARM画像", exact: true }).click();
	await page
		.getByRole("button", { name: "ファイル選択を解除", exact: true })
		.click();
	await page.locator(".artifact-panel-body").evaluate((node) => {
		node.scrollTop = 0;
	});
	await expect(
		page.getByRole("button", { name: "参照…", exact: true }),
	).toBeVisible();
	await page.screenshot({ path: "test-results/model3d-image-picker-tabs.png" });
	await page
		.getByRole("button", { name: "保存画像2を拡大", exact: true })
		.click();
	await expect(
		page.getByRole("img", { name: "保存画像2", exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "画像一覧に戻る" }).click();
	await page
		.getByRole("button", { name: "保存画像1を選ぶ", exact: true })
		.click();
	for (const width of [640, 440, 320, 960]) {
		// A deterministic content width tests the component, not a different server or route.
		await page.locator(".artifact-panel").evaluate((node, size) => {
			(node as HTMLElement).style.width = `${size}px`;
		}, width);
		const overflow = await page
			.locator(".artifact-panel-body")
			.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
		expect(overflow).toBe(false);
	}
	await page.locator(".artifact-panel").evaluate((node) => {
		(node as HTMLElement).style.width = "";
	});
	await page.setViewportSize({ width: 440, height: 600 });
	await page
		.getByRole("button", { name: "保存画像1を選ぶ", exact: true })
		.scrollIntoViewIfNeeded();
	await expect(
		page.getByRole("button", { name: "保存画像1を選ぶ", exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "保存画像1を選ぶ", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "この画像を使う" }),
	).toBeVisible();
	await page.screenshot({ path: "test-results/model3d-image-picker.png" });
	await page.getByRole("button", { name: "この画像を使う" }).click();
	await expect(page.getByRole("textbox", { name: "タイトル" })).toHaveValue(
		"入力途中のタイトル",
	);
	await page.getByLabel("文章から作る").check();
	await expect(page.getByRole("textbox", { name: "作りたいもの" })).toHaveValue(
		"残す文章",
	);
	await page.getByLabel("保存した画像から作る").check();
	await page.getByRole("button", { name: "3Dモデルを生成する" }).click();
	const submitted = await page.evaluate(
		() =>
			(window as unknown as { model3dTest: { submitted: unknown[] } })
				.model3dTest.submitted,
	);
	expect(submitted).toEqual([
		{ title: "入力途中のタイトル", tags: "", prompt: "", imageId: "image-0" },
	]);
});
