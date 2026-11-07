import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import type {} from "./avatar-view.fixture";

let directory: string;
test.beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "eumenes-avatar-view-"));
	// This framing fixture never opens audio input/output; playback has its own real-worklet spec.
	execFileSync(
		"bun",
		[
			"--eval",
			`
 const result = await Bun.build({entrypoints:["tests/browser/avatar-view.fixture.tsx"],outdir:${JSON.stringify(directory)},target:"browser",format:"esm",define:{"process.env.NODE_ENV":JSON.stringify("production")},plugins:[{name:"unused-audio-workers",setup(b){
 b.onResolve({filter:/recorder.worklet.ts\\?worker&url$/},()=>({path:"recorder-url",namespace:"unused-worker"}));
 b.onResolve({filter:/vad.worker.ts\\?worker$/},()=>({path:"vad-worker",namespace:"unused-worker"}));
 b.onLoad({filter:/recorder-url/,namespace:"unused-worker"},()=>({contents:'export default "/unused-recorder.js";',loader:"js"}));
 b.onLoad({filter:/vad-worker/,namespace:"unused-worker"},()=>({contents:'export default class extends Worker { constructor(){super("/unused-vad.js");} }',loader:"js"}));
 }}]});if(!result.success)throw new Error(result.logs.join("\\n"));
 `,
		],
		{ stdio: "pipe" },
	);
});
test.afterAll(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
});

test("background mode adjusts real WebGL framing, keeps it across chat toggles, and works on mobile with reduced motion", async ({
	playwright,
}) => {
	test.skip(
		!existsSync("web/public/live2d/hiyori/Hiyori.moc3"),
		"The local model is not installed.",
	);
	const browser = await playwright.chromium.launch({
		args: [
			"--mute-audio",
			"--use-gl=angle",
			"--use-angle=swiftshader",
			"--enable-unsafe-swiftshader",
		],
	});
	const page = await browser.newPage({
		viewport: { width: 1000, height: 800 },
		reducedMotion: "reduce",
	});
	const errors: string[] = [];
	const requests: string[] = [];
	page.on("pageerror", (error) => {
		errors.push(error.message);
		console.error(error.message);
	});
	page.on("request", (request) =>
		requests.push(new URL(request.url()).pathname),
	);
	try {
		await page.route("http://127.0.0.1/**", (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path.startsWith("/live2d/"))
				return route.fulfill({ path: resolve("web/public", "." + path) });
			if (path === "/fixture.js")
				return route.fulfill({
					contentType: "text/javascript; charset=utf-8",
					body: readFileSync(join(directory, "avatar-view.fixture.js")),
				});
			return route.fulfill({
				contentType: "text/html; charset=utf-8",
				body: '<body><div id="root"></div><script type="module" src="/fixture.js"></script></body>',
			});
		});
		await page.goto("http://127.0.0.1/__avatar_view__");
		await page.addStyleTag({
			content: readFileSync(join(directory, "avatar-view.fixture.css"), "utf8"),
		});
		await expect(page.locator(".hiyori-avatar-background")).toHaveAttribute(
			"data-avatar-state",
			"ready",
		);
		await expect(page.getByText("モデルの表示調整")).toHaveCount(0);
		await page.getByRole("button", { name: "チャットを隠す" }).click();
		await expect(page.getByText("会話の履歴")).toBeHidden();
		await page.getByText("モデルの表示調整").click();
		const matrix = () => page.evaluate(() => window.avatarViewMatrix());
		const original = await matrix();
		expect(original).toHaveLength(16);
		const canvas = page.locator("canvas");
		const before = await canvas.screenshot();
		await page.getByRole("button", { name: "上半身", exact: true }).click();
		await expect
			.poll(async () => (await matrix())[0]! / original[0]!)
			.toBeCloseTo(2.2);
		const after = await canvas.screenshot({
			path: "test-results/hiyori-view-upper-body-canvas.png",
		});
		const beforePixels = await sharp(before).raw().toBuffer();
		const afterPixels = await sharp(after).raw().toBuffer();
		expect(afterPixels.length).toBe(beforePixels.length);
		let changed = 0;
		for (let i = 0; i < beforePixels.length; i++)
			if (Math.abs(beforePixels[i]! - afterPixels[i]!) > 20) changed++;
		expect(changed / beforePixels.length).toBeGreaterThan(0.1);
		await page.screenshot({ path: "test-results/hiyori-view-desktop.png" });
		const zoom = page.getByRole("slider", { name: "ズーム", exact: true });
		await zoom.fill("250");
		await page
			.getByRole("slider", { name: "左右の位置", exact: true })
			.fill("10");
		await page
			.getByRole("slider", { name: "上下の位置", exact: true })
			.fill("5");
		await expect
			.poll(async () => (await matrix())[0]! / original[0]!)
			.toBeCloseTo(2.5);
		await expect.poll(async () => (await matrix())[12]).toBeCloseTo(0.2);
		await expect
			.poll(async () => (await matrix())[13])
			.toBeCloseTo(0.8 * (1 - 2.5) - 0.1);
		const adjusted = await matrix();
		await page.getByRole("button", { name: "チャットを表示" }).click();
		await expect(page.getByText("モデルの表示調整")).toHaveCount(0);
		await expect(page.getByText("会話の履歴")).toBeVisible();
		expect(await matrix()).toEqual(adjusted);
		await page.getByRole("button", { name: "チャットを隠す" }).click();
		await page.getByText("モデルの表示調整").click();
		await expect(zoom).toHaveValue("250");
		await page.getByRole("button", { name: "リセット", exact: true }).click();
		await expect.poll(matrix).toEqual(original);
		await zoom.focus();
		await page.keyboard.press("ArrowRight");
		await expect(zoom).toHaveValue("101");
		await page.setViewportSize({ width: 390, height: 740 });
		await page.getByRole("button", { name: "上半身", exact: true }).click();
		await expect
			.poll(async () => (await matrix())[0]! / (await matrix())[5]!)
			.toBeCloseTo((await canvas.boundingBox())!.height / 390);
		const controls = await page.locator(".hiyori-view-controls").boundingBox();
		expect(controls!.x).toBeGreaterThanOrEqual(0);
		expect(controls!.x + controls!.width).toBeLessThanOrEqual(390);
		await page.screenshot({ path: "test-results/hiyori-view-mobile.png" });
		await page.getByText("モデルの表示調整").click();
		await expect(zoom).toBeHidden();
		await page.screenshot({
			path: "test-results/hiyori-view-mobile-collapsed.png",
		});
		expect(
			requests.filter((path) => path.endsWith("Hiyori.model3.json")),
		).toHaveLength(1);
		await expect(canvas).toHaveCount(1);
		expect(errors).toEqual([]);
	} finally {
		await browser.close();
	}
});

test("framing and reset survive reload, background changes and a real browser restart", async ({
	playwright,
}) => {
	test.skip(
		!existsSync("web/public/live2d/hiyori/Hiyori.moc3"),
		"The local model is not installed.",
	);
	const profile = mkdtempSync(join(tmpdir(), "eumenes-avatar-view-profile-"));
	let context: BrowserContext | undefined;
	const errors: string[] = [];
	const ready = async (page: Page) => {
		await page.addStyleTag({
			content: readFileSync(join(directory, "avatar-view.fixture.css"), "utf8"),
		});
		await expect(page.locator(".hiyori-avatar-background")).toHaveAttribute(
			"data-avatar-state",
			"ready",
		);
	};
	const launch = async () => {
		context = await playwright.chromium.launchPersistentContext(profile, {
			headless: true,
			reducedMotion: "reduce",
			viewport: { width: 1000, height: 800 },
			args: [
				"--mute-audio",
				"--use-gl=angle",
				"--use-angle=swiftshader",
				"--enable-unsafe-swiftshader",
			],
		});
		await context.route("http://127.0.0.1/**", (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path.startsWith("/live2d/"))
				return route.fulfill({ path: resolve("web/public", "." + path) });
			if (path === "/fixture.js")
				return route.fulfill({
					contentType: "text/javascript; charset=utf-8",
					body: readFileSync(join(directory, "avatar-view.fixture.js")),
				});
			return route.fulfill({
				contentType: "text/html; charset=utf-8",
				body: '<body><div id="root"></div><script type="module" src="/fixture.js"></script></body>',
			});
		});
		const page = await context.newPage();
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto("http://127.0.0.1/__avatar_view__");
		await ready(page);
		return page;
	};
	try {
		let page = await launch();
		const original = await page.evaluate(() => window.avatarViewMatrix());
		await page.getByRole("button", { name: "チャットを隠す" }).click();
		await page.getByText("モデルの表示調整").click();
		await page.getByRole("slider", { name: "ズーム", exact: true }).fill("245");
		await page
			.getByRole("slider", { name: "左右の位置", exact: true })
			.fill("-17");
		await page
			.getByRole("slider", { name: "上下の位置", exact: true })
			.fill("9");
		await expect
			.poll(
				async () => (await page.evaluate(() => window.avatarViewMatrix()))[13],
			)
			.toBeCloseTo(0.8 * (1 - 2.45) - 0.18);
		const adjusted = await page.evaluate(() => window.avatarViewMatrix());
		await page.getByRole("button", { name: "背景を切り替える" }).click();
		await expect(page.locator("canvas")).toHaveCount(0);
		await page.getByRole("button", { name: "背景を切り替える" }).click();
		await ready(page);
		expect(await page.evaluate(() => window.avatarViewMatrix())).toEqual(
			adjusted,
		);
		await page.reload();
		await ready(page);
		expect(await page.evaluate(() => window.avatarViewMatrix())).toEqual(
			adjusted,
		);
		await context!.close();
		context = undefined;
		page = await launch();
		expect(await page.evaluate(() => window.avatarViewMatrix())).toEqual(
			adjusted,
		);
		await page.getByRole("button", { name: "チャットを隠す" }).click();
		await page.getByText("モデルの表示調整").click();
		await expect(
			page.getByRole("slider", { name: "ズーム", exact: true }),
		).toHaveValue("245");
		await expect(
			page.getByRole("slider", { name: "左右の位置", exact: true }),
		).toHaveValue("-17");
		await expect(
			page.getByRole("slider", { name: "上下の位置", exact: true }),
		).toHaveValue("9");
		await page.getByRole("button", { name: "リセット", exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => window.avatarViewMatrix()))
			.toEqual(original);
		await context!.close();
		context = undefined;
		page = await launch();
		expect(await page.evaluate(() => window.avatarViewMatrix())).toEqual(
			original,
		);
		expect(errors).toEqual([]);
	} finally {
		await context?.close();
		rmSync(profile, { recursive: true, force: true });
	}
});
