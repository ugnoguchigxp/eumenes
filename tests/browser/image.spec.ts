import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createFixture } from "./fixture";
test.setTimeout(60000);
const fixture = createFixture();
let origin: string;
test.beforeAll(async () => {
	const [apiPort, webPort] = (await fixture.ports(2)) as [number, number];
	origin = `http://127.0.0.1:${webPort}`;
	await fixture.launch(
		["scripts/image-fixture-server.ts"],
		{ EUMENES_PORT: String(apiPort), EUMENES_ORIGIN: origin },
		{ ports: [apiPort] },
	);
	await fixture.ready(`http://127.0.0.1:${apiPort}/api/status`);
	await fixture.launchWeb({
		webPort,
		apiPort,
		token: "fixture-token-for-toolchain-browser",
		cacheDir: `/tmp/eumenes-image-vite-${webPort}`,
	});
	await fixture.ready(origin);
});
test.afterAll(() => fixture.stopAll());
test("OpenUI image studio: selected prompt, protected edits, artifact gallery and result operations", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1514, height: 1039 });
	await page.goto(origin);
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await page.getByRole("menuitem", { name: "画像生成", exact: true }).click();
	const panel = page.getByRole("complementary", { name: "アーティファクト" });
	const studio = panel.locator(".image-workspace");
	await expect(studio).toBeVisible();
	const bounds = await studio.boundingBox();
	const frame = await panel.boundingBox();
	expect(bounds).not.toBeNull();
	expect(frame).not.toBeNull();
	expect(bounds!.x).toBeGreaterThanOrEqual(frame!.x);
	expect(bounds!.width).toBeLessThanOrEqual(frame!.width);
	expect(bounds!.height).toBeLessThanOrEqual(frame!.height);
	expect(bounds!.width).toBeLessThan(1514);
	await expect(studio).toHaveAttribute("data-presentation", "embedded");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	expect(await studio.getByRole("tab").count()).toBe(0);
	await studio.getByLabel("テーマ・描きたいもの").fill("海辺の夕焼け");
	await studio.getByLabel("水彩", { exact: true }).check();
	await studio.getByLabel("温かい", { exact: true }).check();
	await studio.getByLabel("構図", { exact: true }).selectOption("広めの画角");
	const prompt = studio.getByRole("textbox", { name: "画像作成プロンプト" });
	await expect(prompt).toHaveValue(
		"テーマ：海辺の夕焼け\n画風：水彩\n雰囲気：温かい\n構図：広めの画角",
	);
	await prompt.fill("海辺の夕焼け。柔らかな水彩画。");
	await studio.getByLabel("明るい", { exact: true }).check();
	await expect(prompt).toHaveValue("海辺の夕焼け。柔らかな水彩画。");
	await expect(
		studio.getByRole("button", { name: "画像を生成", exact: true }),
	).toBeDisabled();
	await studio.getByRole("button", { name: "編集内容を使う" }).click();
	await studio.getByLabel("幅（px）").fill("121");
	await studio.getByLabel("高さ（px）").fill("177");
	await studio.getByLabel("保存形式").selectOption("png");
	await studio.getByRole("button", { name: "画像一覧", exact: true }).click();
	const gallery = studio.locator(".image-workspace-history");
	await expect(gallery).toBeVisible();
	await expect(
		gallery.getByRole("textbox", { name: "画像作成プロンプト" }),
	).toHaveCount(0);
	const past = gallery.getByRole("button", { name: /画像 .*を表示/ }).first();
	await expect(past).toBeVisible();
	const download = page.waitForEvent("download");
	await gallery
		.getByRole("link", { name: /をダウンロード/ })
		.first()
		.click();
	expect((await download).suggestedFilename()).toBe("image-past-image.png");
	await studio.getByRole("button", { name: "画像生成" }).click();
	await expect(prompt).toHaveValue("海辺の夕焼け。柔らかな水彩画。");
	await expect(studio.getByLabel("水彩", { exact: true })).toBeChecked();
	await studio.getByRole("button", { name: "画像を生成", exact: true }).click();
	await expect(
		studio.getByText("画像が完成しました", { exact: true }),
	).toBeVisible();
	const picture = studio.getByRole("img", { name: "夕焼けの海", exact: true });
	await expect(picture).toBeVisible();
	expect((await picture.boundingBox())!.width).toBeLessThanOrEqual(160);
	expect(
		await picture.evaluate((img: HTMLImageElement) => ({
			width: img.naturalWidth,
			height: img.naturalHeight,
		})),
	).toEqual({ width: 121, height: 177 });
	await expect(prompt).toHaveValue("海辺の夕焼け。柔らかな水彩画。");
	await studio.getByRole("button", { name: "夕焼けの海を拡大" }).click();
	await expect(page.locator('[role="dialog"]')).toHaveCount(1);
	const zoomed = page
		.getByRole("dialog")
		.last()
		.getByRole("img", { name: "夕焼けの海", exact: true });
	await expect(zoomed).toBeVisible();
	expect(
		await zoomed.evaluate((img) => {
			const r = img.getBoundingClientRect();
			return (
				document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === img
			);
		}),
	).toBe(true);
	await page.keyboard.press("Escape");
	await expect(studio).toBeVisible();
	mkdirSync("verification-reports/image-ui-embedded", { recursive: true });
	await page.screenshot({
		path: "verification-reports/image-ui-embedded/creation-light.png",
	});
	await studio.getByRole("button", { name: "画像一覧", exact: true }).click();
	await gallery.getByLabel("画像の並び順").selectOption("asc");
	const splitter = page.getByRole("separator", {
		name: "会話とアーティファクトのサイズを調整",
	});
	await splitter.focus();
	await page.keyboard.press("End");
	await expect(splitter).toHaveAttribute("aria-valuenow", "75");
	expect(await studio.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
		true,
	);
	await page.keyboard.press("Enter");
	await expect(
		gallery.getByRole("button", { name: "夕焼けの海を表示" }),
	).toBeVisible();
	await page.screenshot({
		path: "verification-reports/image-ui-embedded/gallery-light.png",
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({
		path: "verification-reports/image-ui-embedded/gallery-mobile.png",
	});
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
	await studio.getByRole("button", { name: "画像生成" }).click();
	await expect(prompt).toHaveValue("海辺の夕焼け。柔らかな水彩画。");
	await page.screenshot({
		path: "verification-reports/image-ui-embedded/creation-mobile.png",
	});
	await page
		.getByRole("button", { name: "画像生成を閉じる", exact: true })
		.click();
	await expect(panel).toHaveCount(0);
});
test("completed image prompt survives reloading and reopening the OpenUI workspace", async ({
	page,
}) => {
	await page.goto(origin);
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await page.getByRole("menuitem", { name: "画像生成", exact: true }).click();
	const panel = page.getByRole("complementary", { name: "アーティファクト" });
	const studio = panel.locator(".image-workspace");
	await studio
		.getByRole("textbox", { name: "画像作成プロンプト" })
		.fill("再表示する手書きの希望");
	await studio.getByRole("button", { name: "画像を生成", exact: true }).click();
	await expect(
		studio.getByText("画像が完成しました", { exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "画像生成を閉じる", exact: true })
		.click();
	await expect(panel).toHaveCount(0);
	await page.reload();
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await page.getByRole("menuitem", { name: "画像生成", exact: true }).click();
	await expect(
		page.getByRole("textbox", { name: "画像作成プロンプト" }),
	).toHaveValue("再表示する手書きの希望");
});
test("image deletion confirms, preserves failed results, then removes the saved bytes and selected preview", async ({
	page,
}) => {
	await page.goto(origin);
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await page.getByRole("menuitem", { name: "画像生成", exact: true }).click();
	const panel = page.getByRole("complementary", { name: "アーティファクト" });
	const studio = panel.locator(".image-workspace");
	await studio
		.getByRole("textbox", { name: "画像作成プロンプト" })
		.fill("削除操作の確認用画像");
	await studio.getByRole("button", { name: "画像を生成", exact: true }).click();
	await expect(
		studio.getByText("画像が完成しました", { exact: true }),
	).toBeVisible();
	await studio.getByRole("button", { name: "画像一覧", exact: true }).click();
	const gallery = studio.locator(".image-workspace-history");
	const count = await gallery.locator(".image-gallery-card").count();
	let deletes = 0;
	page.on("request", (request) => {
		if (
			request.method() === "DELETE" &&
			request.url().endsWith("/api/images/new-image")
		)
			deletes++;
	});
	await gallery.getByRole("button", { name: "夕焼けの海を削除" }).click();
	const confirm = page.getByRole("dialog", { name: "画像を削除しますか？" });
	await expect(confirm.getByText(/取り消せません/)).toBeVisible();
	mkdirSync("verification-reports/image-delete", { recursive: true });
	await page.screenshot({
		path: "verification-reports/image-delete/confirmation.png",
	});
	await confirm.getByRole("button", { name: "キャンセル" }).click();
	expect(deletes).toBe(0);
	await page.route("**/api/images/new-image", (route) =>
		route.fulfill({
			status: 502,
			contentType: "application/json",
			body: JSON.stringify({ error: "image_delete_unconfirmed" }),
		}),
	);
	await gallery.getByRole("button", { name: "夕焼けの海を削除" }).click();
	await confirm.getByRole("button", { name: "削除する" }).click();
	await expect(
		page.getByText("削除結果を確認できませんでした。一覧を更新してください。"),
	).toBeVisible();
	await expect(
		gallery.getByRole("button", { name: "夕焼けの海を表示" }),
	).toBeVisible();
	expect(deletes).toBe(1);
	await page.unroute("**/api/images/new-image");
	await gallery.getByRole("button", { name: "夕焼けの海を削除" }).click();
	await confirm.getByRole("button", { name: "削除する" }).click();
	await expect(
		page.getByText("画像を削除しました。", { exact: true }),
	).toBeVisible();
	await expect(gallery.locator(".image-gallery-card")).toHaveCount(count - 1);
	await expect(
		gallery.getByRole("button", { name: "夕焼けの海を表示" }),
	).toHaveCount(0);
	expect(deletes).toBe(2);
	await page.screenshot({
		path: "verification-reports/image-delete/gallery-after.png",
	});
	await studio.getByRole("button", { name: "画像生成" }).click();
	await expect(
		studio.locator('img[src="/api/images/new-image/content"]'),
	).toHaveCount(0);
	await expect(
		studio.getByRole("textbox", { name: "画像作成プロンプト" }),
	).toHaveValue("削除操作の確認用画像");
});
