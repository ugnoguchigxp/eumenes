import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createFixture } from "./fixture";
test.setTimeout(120000);
test.use({
	launchOptions: {
		args: [
			"--use-fake-device-for-media-stream",
			"--use-fake-ui-for-media-stream",
		],
	},
});
const fixture = createFixture();
let origin: string;
test.beforeAll(async () => {
	const [apiPort, webPort] = (await fixture.ports(2)) as [number, number];
	origin = `http://127.0.0.1:${webPort}`;
	await fixture.launch(
		["scripts/ocr-fixture-server.ts"],
		{ EUMENES_PORT: String(apiPort), EUMENES_ORIGIN: origin },
		{ ports: [apiPort] },
	);
	await fixture.ready(`http://127.0.0.1:${apiPort}/api/status`);
	await fixture.launchWeb({
		webPort,
		apiPort,
		token: "fixture-token-for-toolchain-browser",
		cacheDir: `/tmp/eumenes-ocr-vite-${webPort}`,
	});
	await fixture.ready(origin);
});
test.afterAll(() => fixture.stopAll());
test("icon upload, raw OCR lines, history and conversation use the registered artifact", async ({
	page,
}) => {
	await page.goto(origin);
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await page
		.getByRole("menuitem", { name: "文字を読み取る", exact: true })
		.click();
	const panel = page.getByRole("complementary", { name: "アーティファクト" });
	await expect(
		panel.getByRole("region", { name: "OCRの元資料" }),
	).toBeVisible();
	await expect(
		panel.getByRole("region", { name: "OCR結果と入力" }),
	).toBeVisible();
	const upload = panel.getByRole("button", {
		name: "画像・動画ファイルをアップロード",
	});
	await expect(upload).toBeEnabled();
	await expect(panel.locator('input[type="file"]')).toHaveCount(1);
	const bytes = await page.evaluate(async () => {
		const canvas = document.createElement("canvas");
		canvas.width = 320;
		canvas.height = 240;
		canvas.getContext("2d")?.fillRect(0, 0, 320, 240);
		const blob = await new Promise<Blob>((resolve) =>
			canvas.toBlob((b) => resolve(b!), "image/png"),
		);
		return Array.from(new Uint8Array(await blob.arrayBuffer()));
	});
	await panel.locator('input[type="file"]').setInputFiles({
		name: "note.png",
		mimeType: "image/png",
		buffer: Buffer.from(bytes),
	});
	await expect(panel.getByText("原文のまま", { exact: true })).toBeVisible();
	await expect(panel.locator(".ocr-polygon")).toHaveCount(2);
	await panel.getByRole("checkbox").first().check();
	await expect(panel.locator(".ocr-polygon.selected")).toHaveCount(1);
	await panel.getByRole("button", { name: "選択箇所を会話に追加" }).click();
	await expect(page.getByText(/OCR原文（資料: note.png/)).toBeVisible();
	await panel.locator('input[type="file"]').setInputFiles({
		name: "second.png",
		mimeType: "image/png",
		buffer: Buffer.from(bytes),
	});
	await expect(
		panel.getByRole("img", { name: "second.pngの原本" }),
	).toBeVisible();
	await panel.getByRole("button", { name: "資料一覧" }).click();
	await expect(panel.getByRole("menuitem", { name: /note.png/ })).toBeVisible();
	await expect(panel.locator(".ocr-history-thumbnail img")).toHaveCount(2);
	await panel.getByRole("menuitem", { name: /note.png/ }).click();
	await expect(
		panel.getByRole("img", { name: "note.pngの原本" }),
	).toBeVisible();
	await panel.locator('input[type="file"]').setInputFiles({
		name: "clip.webm",
		mimeType: "video/webm",
		buffer: readFileSync("tests/browser/fixtures/object-recognition-2s.webm"),
	});
	await expect(panel.getByRole("button", { name: "1秒" })).toBeVisible({
		timeout: 15000,
	});
	await panel.getByRole("button", { name: "1秒" }).click();
	await expect(panel.getByText("二行目", { exact: true })).toBeVisible();
	await panel.getByRole("button", { name: "資料一覧" }).click();
	await expect(panel.locator(".ocr-history-thumbnail img")).toHaveCount(3);
});
