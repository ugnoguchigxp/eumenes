import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import sharp from "sharp";
import { prepareZXingModule, writeBarcode } from "zxing-wasm/writer";
import { harness } from "../api/application/toolchain/toolchain.fixture";

// Uses the real frontend/client/Artifact renderer and in-process API. No HTTP server is started.
const out = resolve("verification-reports/ocr-ui");
mkdirSync(out, { recursive: true });
const built = await Bun.build({
	entrypoints: [resolve("scripts/ocr-ui/app.tsx")],
	outdir: out,
	target: "browser",
	format: "esm",
	minify: false,
	define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
});
if (!built.success) throw new Error(built.logs.map(String).join("\n"));
writeFileSync(
	`${out}/index.html`,
	`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./app.css"><style>body{margin:0;padding:18px;font-family:sans-serif;background:var(--background);color:var(--foreground)}#root{max-width:1280px;margin:auto}</style></head><body><div id="root"></div><script type="module" src="./app.js"></script></body></html>`,
);
prepareZXingModule({
	overrides: {
		wasmBinary: await Bun.file(
			new URL(import.meta.resolve("zxing-wasm/writer/zxing_writer.wasm")),
		).arrayBuffer(),
	},
});
const made = await writeBarcode("確認 OCR-172 https://example.com/qr", {
	format: "QRCode",
	scale: 5,
});
if (!made.image) throw new Error("fixture_qr_failed");
const image = await sharp(
	Buffer.from(
		'<svg xmlns="http://www.w3.org/2000/svg" width="900" height="400"><rect width="900" height="400" fill="white"/><g font-family="sans-serif" font-size="32"><text x="25" y="70">範囲内の文章 OCR-172</text><text x="25" y="145">範囲外の文章</text></g></svg>',
	),
)
	.composite([
		{ input: Buffer.from(await made.image.arrayBuffer()), left: 600, top: 25 },
	])
	.png()
	.toBuffer();
const result = {
	kind: "image",
	model: "fixture",
	width: 900,
	height: 400,
	text: "範囲内の文章 OCR-172\n範囲外の文章",
	lines: [
		{
			text: "範囲内の文章 OCR-172",
			confidence: 0.9,
			polygon: [
				[25, 30],
				[450, 30],
				[450, 80],
				[25, 80],
			],
		},
		{
			text: "範囲外の文章",
			confidence: 0.9,
			polygon: [
				[25, 105],
				[450, 105],
				[450, 155],
				[25, 155],
			],
		},
	],
};
const h = await harness({
	settingsEnv: { LARM_API_TOKEN: "fixture" },
	ocrFetcher: (async () => Response.json(result)) as unknown as typeof fetch,
});
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(15000);
const pageErrors: string[] = [];
const requests: { path: string; method: string }[] = [];
page.on("pageerror", (e) => pageErrors.push(e.stack ?? e.message));
try {
	const config = await h.app.request("/api/settings/ocr", {
		method: "PUT",
		headers: {
			Authorization: "Bearer fixture-token-for-toolchain-browser",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			expectedRevision: 0,
			baseUrl: "http://127.0.0.1:9",
		}),
	});
	expect(config.status).toBe(200);
	await page.route("http://127.0.0.1:19400/**", async (route) => {
		const r = route.request();
		const cors = {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Headers": "*",
			"Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
		};
		if (r.method() === "OPTIONS") {
			await route.fulfill({ status: 204, headers: cors });
			return;
		}
		const url = new URL(r.url());
		if (!url.pathname.startsWith("/api/")) {
			const asset = await Bun.file(
				`${out}/${url.pathname === "/" ? "index.html" : url.pathname.slice(1)}`,
			).arrayBuffer();
			await route.fulfill({
				status: 200,
				contentType: url.pathname.endsWith(".js")
					? "text/javascript"
					: url.pathname.endsWith(".css")
						? "text/css"
						: "text/html",
				body: Buffer.from(asset),
			});
			return;
		}
		requests.push({ path: url.pathname, method: r.method() });
		const headers = r.headers();
		delete headers.origin;
		delete headers.referer;
		const response = await h.app.request(url.pathname + url.search, {
			method: r.method(),
			headers,
			body: r.postDataBuffer()
				? new Uint8Array(r.postDataBuffer()!)
				: undefined,
		});
		await route.fulfill({
			status: response.status,
			headers: { ...Object.fromEntries(response.headers), ...cors },
			body: Buffer.from(await response.arrayBuffer()),
		});
	});
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "clipboard", {
			value: {
				writeText: async (text: string) => {
					(window as unknown as { copied: string }).copied = text;
				},
			},
		});
	});
	await page.goto("http://127.0.0.1:19400/");
	await page
		.locator('input[type="file"]')
		.setInputFiles({
			name: "notice.png",
			mimeType: "image/png",
			buffer: image,
		});
	await expect(
		page
			.getByRole("region", { name: "QRコード" })
			.getByText("確認 OCR-172 https://example.com/qr", { exact: true }),
	).toBeVisible({ timeout: 15000 });
	await page.screenshot({ path: `${out}/desktop.png`, fullPage: true });
	await page.getByRole("button", { name: "QRの内容をコピー" }).click();
	expect(
		await page.evaluate(() => (window as unknown as { copied: string }).copied),
	).toBe("確認 OCR-172 https://example.com/qr");
	await page.getByRole("button", { name: "範囲を選ぶ", exact: true }).click();
	const area = await page.locator(".ocr-stage svg").boundingBox();
	if (!area) throw new Error("stage_missing");
	await page.mouse.move(
		area.x + (10 / 900) * area.width,
		area.y + (10 / 400) * area.height,
	);
	await page.mouse.down();
	await page.mouse.move(
		area.x + (470 / 900) * area.width,
		area.y + (90 / 400) * area.height,
		{ steps: 8 },
	);
	await page.mouse.up();
	await expect(
		page.getByRole("heading", { name: "範囲内のOCR原文（1行）" }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "範囲内をコピー", exact: true })
		.click();
	expect(
		await page.evaluate(() => (window as unknown as { copied: string }).copied),
	).toBe("範囲内の文章 OCR-172");
	await page.getByRole("button", { name: "大きく表示", exact: true }).click();
	await expect(
		page.getByRole("dialog", { name: "OCR原画像の拡大表示" }),
	).toBeVisible();
	await page.getByRole("button", { name: "選択領域を拡大" }).click();
	await page.screenshot({ path: `${out}/expanded.png`, fullPage: true });
	await page.getByRole("spinbutton", { name: "範囲の高さ" }).fill("165");
	await page.keyboard.press("Tab");
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("button", { name: "大きく表示", exact: true }),
	).toBeFocused();
	await expect(
		page.getByRole("heading", { name: "範囲内のOCR原文（2行）" }),
	).toBeVisible();
	await page.getByRole("button", { name: "範囲を解除" }).click();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: `${out}/narrow.png`, fullPage: true });
	await page.getByRole("button", { name: "QRの位置を見る" }).click();
	await expect(page.locator(".ocr-correction-region")).toBeVisible();
	expect(pageErrors).toEqual([]);
	expect(
		requests.filter((r) => r.method === "POST" && r.path === "/api/ocr"),
	).toHaveLength(1);
	expect(
		requests.filter(
			(r) => r.path.endsWith("/corrections") && r.method === "POST",
		),
	).toHaveLength(0);
	writeFileSync(
		`${out}/results.json`,
		JSON.stringify(
			{
				passed: true,
				lane: "browser-with-in-process-api-and-fixture-ocr",
				pageErrors,
				requests,
			},
			null,
			2,
		),
	);
} catch (cause) {
	writeFileSync(
		`${out}/failure.json`,
		JSON.stringify(
			{
				pageErrors,
				requests,
				body: await page
					.locator("body")
					.innerText()
					.catch(() => ""),
				error: String(cause),
			},
			null,
			2,
		),
	);
	await page
		.screenshot({ path: `${out}/failure.png`, fullPage: true })
		.catch(() => {});
	throw cause;
} finally {
	await browser.close();
	await h.close();
}
