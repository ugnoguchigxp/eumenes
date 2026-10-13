import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { createFixture } from "../tests/browser/fixture";
import { harness } from "../api/application/toolchain.fixture";
import { imageFixture } from "../api/application/image.fixture";
import { createLarmPlayground } from "../api/domains/larm";
import { liveLarmSettings } from "./live-larm";
import { resolveLarmToken } from "../api/infrastructure/auth-config";
if (!process.argv.includes("--run"))
	throw new Error("use --run for read-only saved-image UI verification");
const out = resolve(
	"verification-reports/image-ui-embedded-live",
	new Date().toISOString().replaceAll(":", "-"),
);
mkdirSync(out, { recursive: true });
const saved = liveLarmSettings();
const requests: Array<{ path: string; status: number }> = [];
const base = createLarmPlayground({
	...saved,
	baseUrl: saved.baseUrl ?? undefined,
	voice: saved.voice ?? undefined,
	token: resolveLarmToken(process.env),
	fetch: (async (url, init) => {
		if (init?.method && init.method !== "GET")
			throw new Error("read_only_image_check");
		const r = await fetch(url, init);
		requests.push({ path: new URL(String(url)).pathname, status: r.status });
		return r;
	}) as typeof fetch,
});
// A bounded display sample; production returns the complete LARM list.
const sample = await base.images.list(AbortSignal.timeout(15000));
const images = sample.images
	.slice()
	.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
	.slice(0, 12);
if (!images.length) throw new Error("saved_images_required");
const first = images[0]!;
const fixture = createFixture();
const webPort = await fixture.port();
const origin = `http://127.0.0.1:${webPort}`;
process.env.EUMENES_ORIGIN = origin;
const f = imageFixture("studio");
const h = await harness({
	model: f.model,
	imageGateway: () => ({
		...base,
		images: { ...base.images, list: async () => ({ ...sample, images }) },
	}),
	timers: true,
});
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
	const settings = h.settings.get();
	const changed = await h.request("/api/settings/apply", {
		requestId: crypto.randomUUID(),
		expectedRevision: settings.revision,
		settings: {
			...settings,
			larm: saved,
			general: { ...settings.general, theme: "dark" },
			voice: { ...settings.voice, autoSpeak: false },
		},
		keys: [],
	});
	if (!changed.ok) throw new Error("test_settings_not_saved");
	const accepted = await (
		await h.request("/api/runs", {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "画像の制作画面を開いてください。画像は生成しません。",
		})
	).json();
	const run = await h.dialogue.waitForTerminal(accepted.id, {
		timeoutMs: 5000,
	});
	if (
		run?.status !== "completed" ||
		h.image!.list("main")[0]?.action !== "studio"
	)
		throw new Error("studio_not_ready");
	server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: h.app.fetch });
	await fixture.launchWeb({
		webPort,
		apiPort: server.port!,
		token: "fixture-token-for-toolchain-browser",
		cacheDir: `/tmp/eumenes-image-ui-live-${webPort}`,
	});
	await fixture.ready(origin);
	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({
		viewport: { width: 1514, height: 1039 },
	});
	const failures: string[] = [];
	page.on("pageerror", (error) => failures.push(error.message));
	await page.goto(origin);
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await page.getByRole("menuitem", { name: "画像生成", exact: true }).click();
	const panel = page.getByRole("complementary", { name: "アーティファクト" });
	const studio = panel.locator(".image-workspace");
	await expect(studio).toBeVisible();
	await expect(studio).toHaveAttribute("data-presentation", "embedded");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await studio
		.getByLabel("テーマ・描きたいもの")
		.fill("穏やかな朝の海と白い灯台");
	await studio.getByLabel("水彩", { exact: true }).check();
	await studio.getByLabel("落ち着いた", { exact: true }).check();
	await studio.getByLabel("温かい", { exact: true }).check();
	await studio.getByLabel("構図", { exact: true }).selectOption("広めの画角");
	await studio.getByLabel("光", { exact: true }).selectOption("朝の自然光");
	await studio.getByLabel("幅（px）").fill(String(Math.min(first.width, 1280)));
	await studio
		.getByLabel("高さ（px）")
		.fill(String(Math.min(first.height, 1280)));
	await studio.getByLabel("保存形式").selectOption(first.format);
	const preview = studio.locator(".image-preview-frame img");
	await expect(preview).toBeVisible();
	await expect
		.poll(() => preview.evaluate((img: HTMLImageElement) => img.naturalWidth))
		.toBe(first.width);
	await preview.scrollIntoViewIfNeeded();
	if ((await preview.boundingBox())!.width > 160)
		throw new Error("image_preview_not_compact");
	await page.screenshot({ path: `${out}/creation-dark.png` });
	await studio.getByRole("button", { name: "画像一覧", exact: true }).click();
	const gallery = studio.locator(".image-workspace-history");
	await expect(gallery.locator(".image-gallery-card")).toHaveCount(
		images.length,
	);
	await expect
		.poll(() =>
			gallery
				.locator(".image-gallery-thumbnail img")
				.evaluateAll((imgs) =>
					imgs.every(
						(img) =>
							(img as HTMLImageElement).complete &&
							(img as HTMLImageElement).naturalWidth > 0,
					),
				),
		)
		.toBe(true);
	await page.screenshot({ path: `${out}/gallery-dark.png` });
	const downloadEvent = page.waitForEvent("download");
	await gallery
		.getByRole("link", { name: /をダウンロード/ })
		.first()
		.click();
	const download = await downloadEvent;
	await download.saveAs(`${out}/download.${first.format}`);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: `${out}/gallery-mobile-dark.png` });
	await studio.getByRole("button", { name: "画像生成" }).click();
	await page.screenshot({ path: `${out}/creation-mobile-dark.png` });
	await page
		.getByRole("button", { name: "画像生成を閉じる", exact: true })
		.click();
	await expect(panel).toHaveCount(0);
	if (failures.length) throw new Error("image_ui_page_error");
	const report = {
		runId: run.id,
		model: "fixture for UI only",
		live: "LARM saved-image reads only",
		displayed: images.length,
		first: { id: first.id, width: first.width, height: first.height },
		generationPosts: 0,
		requests,
		failures,
	};
	writeFileSync(`${out}/result.json`, JSON.stringify(report, null, 2), {
		mode: 0o600,
	});
	console.log(
		JSON.stringify({
			result: "passed",
			out,
			displayed: images.length,
			generationPosts: 0,
		}),
	);
} finally {
	await browser?.close();
	await fixture.stopAll();
	server?.stop(true);
	await h.close();
}
