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
	await panel.getByRole("tab", { name: "全文", exact: true }).click();
	await expect(panel.locator(".ocr-raw-text")).toHaveText("原文のまま\n二行目");
	await expect(panel.locator(".ocr-polygon")).toHaveCount(2);
	await panel.getByRole("tab", { name: "行ごと", exact: true }).click();
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
	await panel.getByRole("tab", { name: "全文", exact: true }).click();
	await expect(panel.locator(".ocr-raw-text")).toHaveText("二行目");
	await panel.getByRole("button", { name: "資料一覧" }).click();
	await expect(panel.locator(".ocr-history-thumbnail img")).toHaveCount(3);
});
test("correction action renders structured table, evidence and explicit adoption", async ({
	page,
}) => {
	let candidate: any = null;
	let preferredId: string | null = null;
	let preferenceRevision = 0;
	await page.route("**/api/ocr/**/corrections**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		const sourceId = path.match(/\/api\/ocr\/([^/]+)\/corrections/)?.[1] ?? "";
		if (request.method() === "POST" && path.endsWith("/corrections")) {
			const input = request.postDataJSON();
			candidate = {
				id: input.requestId,
				sourceId,
				frameIndex: null,
				sourceRevision: input.expectedRevision,
				sourceDigest: "0".repeat(64),
				state: "completed",
				errorCode: null,
				result: {
					blocks: [
						{
							kind: "table",
							rows: 1,
							columns: 2,
							evidence: { lineIndexes: [0] },
							uncertain: true,
							uncertainty: "罫線が薄い",
							cells: [
								{
									row: 0,
									column: 0,
									rowSpan: 1,
									columnSpan: 1,
									text: "補正後",
									evidence: { lineIndexes: [0] },
									uncertain: false,
								},
								{
									row: 0,
									column: 1,
									rowSpan: 1,
									columnSpan: 1,
									text: "二行目",
									evidence: { lineIndexes: [], region: [0, 0, 50, 20] },
									uncertain: false,
								},
							],
						},
					],
					excludedLines: [{ index: 1, reason: "重複" }],
				},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			return route.fulfill({
				status: 202,
				contentType: "application/json",
				body: JSON.stringify(candidate),
			});
		}
		if (request.method() === "GET" && path.endsWith("/corrections"))
			return route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({
					items:
						candidate && candidate.sourceId === sourceId ? [candidate] : [],
					nextCursor: null,
					preference: { preferredId, revision: preferenceRevision },
				}),
			});
		if (request.method() === "PUT" && path.endsWith("/preference")) {
			const input = request.postDataJSON();
			preferredId = input.preferredId;
			preferenceRevision++;
			return route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({ preferredId, revision: preferenceRevision }),
			});
		}
		return route.fallback();
	});
	await page.goto(origin);
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await page
		.getByRole("menuitem", { name: "文字を読み取る", exact: true })
		.click();
	const panel = page.getByRole("complementary", { name: "アーティファクト" });
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
		name: "correction.png",
		mimeType: "image/png",
		buffer: Buffer.from(bytes),
	});
	await expect(
		panel.getByRole("button", { name: "補正案を作る" }),
	).toBeEnabled();
	await panel.getByRole("button", { name: "補正案を作る" }).click();
	await expect(panel.locator(".ocr-correction-table td")).toHaveCount(2);
	await expect(panel.locator(".ocr-correction-table")).toContainText(
		"判読困難: 罫線が薄い",
	);
	await expect(panel.locator(".ocr-correction-exclusions")).toContainText(
		"2行目: 重複",
	);
	await expect(panel.locator(".ocr-correction-table td").first()).toContainText(
		"補正後",
	);
	await panel.getByRole("button", { name: "根拠を見る" }).first().click();
	await expect(panel.locator(".ocr-polygon.selected")).toHaveCount(1);
	await panel.getByRole("button", { name: "この案を採用" }).click();
	await expect(
		panel.getByRole("heading", { name: "採用中の補正案" }),
	).toBeVisible();
	await panel.getByRole("button", { name: "原文を既定に戻す" }).click();
	await expect(
		panel.getByRole("heading", { name: "読み取った原文" }),
	).toBeVisible();
});
