import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
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
		["scripts/object-recognition-fixture-server.ts"],
		{ EUMENES_PORT: String(apiPort), EUMENES_ORIGIN: origin },
		{ ports: [apiPort] },
	);
	await fixture.ready(`http://127.0.0.1:${apiPort}/api/status`);
	await fixture.launchWeb({
		webPort,
		apiPort,
		token: "fixture-token-for-toolchain-browser",
		cacheDir: `/tmp/eumenes-recognition-vite-${webPort}`,
	});
	await fixture.ready(origin);
});
test.afterAll(() => fixture.stopAll());
test("recognition stays inside artifact: selected image, camera capture, video seek, cancel and conversation", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 1040 });
	await page.goto(origin);
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await page
		.getByRole("menuitem", { name: "映っている物を調べる", exact: true })
		.click();
	const panel = page.getByRole("complementary", { name: "アーティファクト" });
	const workspace = panel.locator(".recognition-workspace");
	await expect(workspace).toBeVisible();
	await expect
		.poll(async () => {
			const main = await workspace.locator(".recognition-main").boundingBox();
			const side = await workspace.locator(".recognition-side").boundingBox();
			return !!main && !!side && main.x + main.width <= side.x + 2;
		})
		.toBe(true);
	await expect(workspace.getByLabel("画像・動画を選ぶ")).toBeEnabled();
	await workspace.getByLabel("物体認識の認証方式").selectOption("larm");
	await expect(workspace.getByLabel("物体認識の認証方式")).toHaveValue("larm");
	await expect(workspace.getByLabel("画像・動画を選ぶ")).toBeEnabled();
	const frame = await panel.boundingBox(),
		bounds = await workspace.boundingBox();
	expect(bounds!.x).toBeGreaterThanOrEqual(frame!.x);
	expect(bounds!.width).toBeLessThanOrEqual(frame!.width);
	expect(bounds!.width).toBeLessThan(1440);
	await expect(page.getByRole("dialog")).toHaveCount(0);
	const bytes = await page.evaluate(async () => {
		const c = document.createElement("canvas");
		c.width = 320;
		c.height = 240;
		const ctx = c.getContext("2d")!;
		ctx.fillStyle = "#dce8e4";
		ctx.fillRect(0, 0, 320, 240);
		ctx.fillStyle = "#245a69";
		ctx.fillRect(130, 30, 150, 170);
		ctx.fillStyle = "#fff";
		ctx.fillRect(30, 40, 60, 110);
		const blob = await new Promise<Blob>((r) =>
			c.toBlob((b) => r(b!), "image/png"),
		);
		return Array.from(new Uint8Array(await blob.arrayBuffer()));
	});
	await workspace.getByLabel("画像・動画を選ぶ").setInputFiles({
		name: "desk.png",
		mimeType: "image/png",
		buffer: Buffer.from(bytes),
	});
	await expect(workspace.getByText("解析完了", { exact: true })).toBeVisible();
	await expect(workspace.locator(".recognition-boxes rect")).toHaveCount(2);
	await expect(workspace.getByRole("img", { name: "desk.png" })).toBeVisible();
	await workspace
		.getByRole("button", { name: "表示中の結果を会話に追加" })
		.click();
	await expect(
		page.getByText(/物体検出の観測結果（資料: desk.png/),
	).toBeVisible();
	await workspace.getByRole("button", { name: "カメラを開く" }).click();
	await expect(workspace.getByLabel("カメラプレビュー")).toBeVisible();
	await workspace.getByRole("button", { name: "撮影して調べる" }).click();
	await expect(
		workspace.getByRole("img", { name: "camera.jpg" }),
	).toBeVisible();
	await expect(workspace.getByLabel("カメラプレビュー")).toBeHidden();
	await expect(workspace.getByLabel("画像・動画を選ぶ")).toBeEnabled();
	const videoBytes = readFileSync(
		"tests/browser/fixtures/object-recognition-2s.webm",
	);
	await expect(workspace.getByLabel("画像・動画を選ぶ")).toBeEnabled();
	await workspace.getByLabel("画像・動画を選ぶ").setInputFiles({
		name: "clip.webm",
		mimeType: "video/webm",
		buffer: videoBytes,
	});
	await expect(
		workspace.getByRole("button", { name: "1.0秒 · 1件" }),
	).toBeVisible({ timeout: 15000 });
	mkdirSync("spec/verification/object-recognition-screen-2026-10-14", {
		recursive: true,
	});
	await expect
		.poll(() =>
			workspace
				.getByLabel("保存した動画")
				.evaluate((v: HTMLVideoElement) =>
					v.seekable.length ? v.seekable.end(0) : 0,
				),
		)
		.toBeGreaterThan(1);
	await workspace.getByRole("button", { name: "1.0秒 · 1件" }).click();
	await expect
		.poll(
			() =>
				workspace
					.getByLabel("保存した動画")
					.evaluate((v: HTMLVideoElement) => v.currentTime),
			{ timeout: 5000 },
		)
		.toBeCloseTo(1, 1);
	await workspace.getByRole("button", { name: "0.5秒 · 0件" }).click();
	await expect(
		workspace.getByText("検出対象は見つかりませんでした。"),
	).toBeVisible();
	await workspace.getByRole("button", { name: "1.0秒 · 1件" }).click();
	mkdirSync("spec/verification/object-recognition-screen-2026-10-14", {
		recursive: true,
	});
	await panel.screenshot({
		path: "spec/verification/object-recognition-screen-2026-10-14/artifact-video.png",
	});
	await expect(workspace.getByLabel("画像・動画を選ぶ")).toBeEnabled();
	await workspace.getByLabel("画像・動画を選ぶ").setInputFiles({
		name: "cancel.webm",
		mimeType: "video/webm",
		buffer: videoBytes,
	});
	const runningButton = workspace.locator(".recognition-submit-loading");
	await expect(runningButton).toBeVisible();
	await expect(runningButton).toHaveAttribute("aria-busy", "true");
	await expect(runningButton.locator(".recognition-spinner")).toBeVisible();
	await panel.screenshot({
		path: "spec/verification/object-recognition-screen-2026-10-14/artifact-running.png",
	});
	await workspace.getByRole("button", { name: "取消", exact: true }).click();
	await expect(workspace.getByText("中止", { exact: true })).toBeVisible();
	await expect(runningButton).toHaveCount(0);
	await expect(workspace.getByLabel("検出枠")).toHaveCount(0);
	await page.reload();
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await page
		.getByRole("menuitem", { name: "映っている物を調べる", exact: true })
		.click();
	await workspace
		.getByRole("button", { name: "資料一覧", exact: true })
		.click();
	const history = workspace.getByRole("menu", { name: "資料一覧" });
	await expect(
		history.getByRole("menuitem", { name: /clip.webm/ }),
	).toBeVisible();
	await panel.screenshot({
		path: "spec/verification/object-recognition-screen-2026-10-14/artifact-history.png",
	});
	await history.getByRole("menuitem", { name: /cancel.webm/ }).click();
	await expect(workspace.getByLabel("保存した動画")).toBeVisible();
	await expect
		.poll(() =>
			workspace
				.getByLabel("保存した動画")
				.evaluate((video: HTMLVideoElement) =>
					video.seekable.length ? video.seekable.end(0) : 0,
				),
		)
		.toBeGreaterThan(1);
	await expect(workspace.getByLabel("検出枠")).toHaveCount(0);
	await panel.screenshot({
		path: "spec/verification/object-recognition-screen-2026-10-14/artifact-restored-cancelled.png",
	});
	await workspace
		.getByRole("button", { name: "資料一覧", exact: true })
		.click();
	await history.getByRole("menuitem", { name: /desk.png/ }).click();
	await expect(workspace.getByRole("img", { name: "desk.png" })).toBeVisible();
	await workspace
		.getByRole("button", { name: "資料一覧", exact: true })
		.click();
	await history.getByRole("button", { name: "cancel.webmを削除" }).click();
	await expect(
		history.getByRole("group", { name: "cancel.webmの削除確認" }),
	).toBeVisible();
	await history.getByRole("button", { name: "削除する" }).click();
	await workspace
		.getByRole("button", { name: "資料一覧", exact: true })
		.click();
	await expect(
		history.getByRole("menuitem", { name: /cancel.webm/ }),
	).toHaveCount(0);
	await workspace
		.getByRole("button", { name: "資料一覧", exact: true })
		.click();
	await page.setViewportSize({ width: 1440, height: 1040 });
	const separator = await page
		.getByRole("separator", { name: "会話とアーティファクトのサイズを調整" })
		.boundingBox();
	await page.mouse.move(
		separator!.x + separator!.width / 2,
		separator!.y + 100,
	);
	await page.mouse.down();
	await page.mouse.move(1030, separator!.y + 100);
	await page.mouse.up();
	await panel.screenshot({
		path: "spec/verification/object-recognition-screen-2026-10-14/artifact-narrow.png",
	});
	expect((await workspace.boundingBox())!.width).toBeLessThanOrEqual(
		(await panel.boundingBox())!.width,
	);
});

test("history restores a cancelled video's original playback while the camera is open", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 1040 });
	await page.goto(origin);
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await page
		.getByRole("menuitem", { name: "映っている物を調べる", exact: true })
		.click();
	const workspace = page
		.getByRole("complementary", { name: "アーティファクト" })
		.locator(".recognition-workspace");
	await workspace.getByLabel("物体認識の認証方式").selectOption("larm");
	const videoBytes = readFileSync(
		"tests/browser/fixtures/object-recognition-2s.webm",
	);
	await workspace.getByLabel("画像・動画を選ぶ").setInputFiles({
		name: "cancel.webm",
		mimeType: "video/webm",
		buffer: videoBytes,
	});
	await expect(
		workspace.getByRole("button", { name: "取消", exact: true }),
	).toBeVisible();
	await workspace.getByRole("button", { name: "取消", exact: true }).click();
	await expect(workspace.getByText("中止", { exact: true })).toBeVisible();
	const imageBytes = await page.evaluate(async () => {
		const canvas = document.createElement("canvas");
		canvas.width = 16;
		canvas.height = 16;
		const blob = await new Promise<Blob>((resolve) =>
			canvas.toBlob((value) => resolve(value!), "image/png"),
		);
		return Array.from(new Uint8Array(await blob.arrayBuffer()));
	});
	await workspace.getByLabel("画像・動画を選ぶ").setInputFiles({
		name: "desk.png",
		mimeType: "image/png",
		buffer: Buffer.from(imageBytes),
	});
	await expect(workspace.getByRole("img", { name: "desk.png" })).toBeVisible();
	await page.reload();
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await page
		.getByRole("menuitem", { name: "映っている物を調べる", exact: true })
		.click();
	await expect(workspace.getByRole("img", { name: "desk.png" })).toBeVisible();
	await workspace.getByRole("button", { name: "カメラを開く" }).click();
	await expect(workspace.getByLabel("カメラプレビュー")).toBeVisible();
	await workspace
		.getByRole("button", { name: "資料一覧", exact: true })
		.click();
	await workspace
		.getByRole("menu", { name: "資料一覧" })
		.getByRole("menuitem", { name: /cancel.webm/ })
		.click();
	await expect(workspace.getByLabel("カメラプレビュー")).toBeHidden();
	const video = workspace.getByLabel("保存した動画");
	await expect(video).toBeVisible();
	await expect
		.poll(() =>
			video.evaluate((element: HTMLVideoElement) =>
				element.seekable.length ? element.seekable.end(0) : 0,
			),
		)
		.toBeGreaterThan(1);
	await expect(workspace.getByLabel("検出枠")).toHaveCount(0);
});

test("camera recording finishes through the artifact controls", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1440, height: 1040 });
	await page.goto(origin);
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await page
		.getByRole("menuitem", { name: "映っている物を調べる", exact: true })
		.click();
	const workspace = page
		.getByRole("complementary", { name: "アーティファクト" })
		.locator(".recognition-workspace");
	await expect(
		workspace.getByRole("button", { name: "カメラを開く" }),
	).toBeEnabled();
	await workspace.getByRole("button", { name: "カメラを開く" }).click();
	await expect(workspace.getByLabel("カメラプレビュー")).toBeVisible();
	const preview = workspace.getByLabel("カメラプレビュー");
	const previewTime = () =>
		preview.evaluate((v: HTMLVideoElement) => v.currentTime);
	const recordingFrom = await previewTime();
	await workspace.getByRole("button", { name: "録画を開始" }).click();
	await expect(workspace.locator(".recognition-record-dot")).toBeVisible();
	await expect(
		workspace.getByRole("button", { name: "資料一覧", exact: true }),
	).toBeDisabled();
	const finish = workspace.getByRole("button", {
		name: "録画を終了して調べる",
	});
	await expect(finish).toBeVisible();
	// Record at least a second of the live preview before finishing.
	await expect
		.poll(previewTime, { timeout: 10_000 })
		.toBeGreaterThan(recordingFrom + 1);
	await expect(finish).toBeVisible();
	await finish.click({ timeout: 5000 });
	await workspace
		.getByRole("button", { name: "資料一覧", exact: true })
		.click();
	await expect(
		workspace.getByRole("menuitem", { name: /camera.webm/ }),
	).toBeVisible();
});
