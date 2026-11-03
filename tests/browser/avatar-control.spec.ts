import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {} from "./avatar-control.fixture";
import sharp from "sharp";
let directory: string;
test.beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "eumenes-avatar-control-"));
	execFileSync(
		"bun",
		[
			"--eval",
			`
 const worklet = await Bun.build({entrypoints:["web/src/domains/audio/worklet/recorder.worklet.ts"],outdir:${JSON.stringify(directory)},target:"browser"});if(!worklet.success)throw new Error(worklet.logs.join("\\n"));
 const source = await Bun.file(${JSON.stringify(directory)}+"/recorder.worklet.js").text();
 const result = await Bun.build({entrypoints:["tests/browser/avatar-control.fixture.ts", "tests/browser/avatar-lifecycle.fixture.tsx"],outdir:${JSON.stringify(directory)},target:"browser",format:"iife",define:{"process.env.NODE_ENV":JSON.stringify("production")},plugins:[{name:"worklet-url",setup(b){
 b.onResolve({filter:/recorder.worklet.ts\\?worker&url$/},()=>({path:"recorder-url",namespace:"worklet-url"}));
 b.onResolve({filter:/vad.worker.ts\\?worker$/},()=>({path:"vad-worker",namespace:"vad-worker"}));
 b.onLoad({filter:/.*/,namespace:"vad-worker"},()=>({contents:'export default class extends Worker { constructor(){super("/unused-vad.js");} }',loader:"js"}));
 b.onLoad({filter:/.*/,namespace:"worklet-url"},()=>({contents:'export default URL.createObjectURL(new Blob(['+JSON.stringify(source)+'],{type:"text/javascript"}));',loader:"js"}));
 }}]});if(!result.success)throw new Error(result.logs.join("\\n"));
	`,
		],
		{ stdio: "pipe" },
	);
});
test.afterAll(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
});

test("real Hiyori WebGL follows TTS and Live playback only, closes and survives remounts", async ({
	playwright,
}) => {
	test.skip(
		!existsSync("web/public/live2d/hiyori/Hiyori.moc3"),
		"Install the local Hiyori model; it is excluded from Git.",
	);
	const browser = await playwright.chromium.launch({
		args: [
			"--mute-audio",
			"--autoplay-policy=no-user-gesture-required",
			"--use-gl=angle",
			"--use-angle=swiftshader",
			"--enable-unsafe-swiftshader",
		],
	});
	const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		await page.route("http://127.0.0.1/**", async (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path.startsWith("/live2d/"))
				return route.fulfill({ path: resolve("web/public", "." + path) });
			if (path === "/recorder.js")
				return route.fulfill({
					contentType: "text/javascript; charset=utf-8",
					body: readFileSync(join(directory, "recorder.worklet.js")),
				});
			if (path === "/fixture.js")
				return route.fulfill({
					contentType: "text/javascript; charset=utf-8",
					body: readFileSync(join(directory, "avatar-control.fixture.js")),
				});
			return route.fulfill({
				contentType: "text/html; charset=utf-8",
				body: '<body style="margin:0;background:#182030"><div id="avatar" style="width:900px;height:700px"></div><script src="/fixture.js"></script></body>',
			});
		});
		await page.goto("http://127.0.0.1/__avatar_fixture__");
		await expect
			.poll(() =>
				page.evaluate(
					() => document.body.dataset.error ?? document.body.dataset.ready,
				),
			)
			.toBe("true");
		await expect
			.poll(() => page.evaluate(() => window.avatarTest.stats().mouthOpen))
			.toBe(0);
		await page.evaluate(() => window.avatarTest.music(true));
		await page.waitForTimeout(200);
		expect(await page.evaluate(() => window.avatarTest.stats().mouthOpen)).toBe(
			0,
		);
		await page.evaluate(() => window.avatarTest.tts(0.3, 0));
		await page.waitForTimeout(150);
		expect(await page.evaluate(() => window.avatarTest.stats().mouthOpen)).toBe(
			0,
		);
		await page.evaluate(() => window.avatarTest.tts(1));
		await expect
			.poll(() => page.evaluate(() => window.avatarTest.stats().mouthOpen))
			.toBeGreaterThan(0.1);
		await page.evaluate(() => window.avatarTest.expression("joyful"));
		const screenshot = await page.screenshot({
			path: "test-results/hiyori-speaking.png",
		});
		const { data, info } = await sharp(screenshot)
			.removeAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });
		let painted = 0,
			white = 0;
		for (let i = 0; i < data.length; i += info.channels) {
			if (data[i]! > 80) painted++;
			if (data[i]! > 250 && data[i + 1]! > 250 && data[i + 2]! > 250) white++;
		}
		expect(painted / (info.width * info.height)).toBeGreaterThan(0.01);
		expect(white / (info.width * info.height)).toBeLessThan(0.03);
		await page.evaluate(() => window.avatarTest.stop());
		await expect
			.poll(() => page.evaluate(() => window.avatarTest.stats().mouthOpen))
			.toBe(0);
		await page.evaluate(() => window.avatarTest.tts(0.4, 0.15, false));
		await page.waitForTimeout(200);
		expect(await page.evaluate(() => window.avatarTest.stats().mouthOpen)).toBe(
			0,
		);
		await page.evaluate(() => window.avatarTest.live());
		await expect
			.poll(() => page.evaluate(() => window.avatarTest.stats().mouthOpen))
			.toBeGreaterThan(0.1);
		await expect
			.poll(() => page.evaluate(() => window.avatarTest.stats().mouthOpen))
			.toBe(0);
		for (let i = 0; i < 3; i++) {
			await page.evaluate(() => window.avatarTest.live(1));
			await expect
				.poll(() => page.evaluate(() => window.avatarTest.stats().mouthOpen))
				.toBeGreaterThan(0.1);
			await page.evaluate(() => window.avatarTest.closeLive());
			await expect
				.poll(() => page.evaluate(() => window.avatarTest.stats().mouthOpen))
				.toBe(0);
			await page.evaluate(() => window.avatarTest.remount());
			expect(
				await page.evaluate(() => window.avatarTest.stats().canvases),
			).toBe(1);
		}
		expect(
			await page
				.locator('script[src="/live2d/live2dcubismcore.min.js"]')
				.count(),
		).toBe(1);
		expect(errors).toEqual([]);
		await page.evaluate(() => window.avatarTest.close());
		expect(await page.locator("canvas").count()).toBe(0);
	} finally {
		await browser.close();
	}
});

test("missing model files never prevent startup, conversation controls or switching backgrounds", async ({
	playwright,
}) => {
	const browser = await playwright.chromium.launch({ args: ["--mute-audio"] });
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		await page.route("http://127.0.0.1/**", async (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path.startsWith("/live2d/hiyori/"))
				return route.fulfill({ status: 404, body: "missing" });
			if (path.startsWith("/live2d/"))
				return route.fulfill({ path: resolve("web/public", "." + path) });
			if (path === "/fixture.js")
				return route.fulfill({
					contentType: "text/javascript; charset=utf-8",
					body: readFileSync(join(directory, "avatar-lifecycle.fixture.js")),
				});
			return route.fulfill({
				contentType: "text/html; charset=utf-8",
				body: '<body><div id="root"></div><script src="/fixture.js"></script></body>',
			});
		});
		await page.goto("http://127.0.0.1/__avatar_missing__");
		await page.addStyleTag({
			content: readFileSync(
				join(directory, "avatar-lifecycle.fixture.css"),
				"utf8",
			),
		});
		await expect(page.locator(".hiyori-avatar-background")).toHaveAttribute(
			"data-avatar-state",
			"load-failed",
		);
		await expect(page.locator(".hiyori-avatar-unavailable")).toContainText(
			"引き続き利用できます",
		);
		await page
			.getByRole("textbox", { name: "メッセージ" })
			.fill("モデルがなくても入力できる");
		await page.getByRole("button", { name: "会話を続ける" }).click();
		await expect(page.getByLabel("会話の操作回数")).toHaveText("1");
		for (let i = 0; i < 3; i++) {
			await page.getByRole("button", { name: "背景を切り替える" }).click();
			await expect(page.getByText("ほかの背景")).toBeVisible();
			await page.getByRole("button", { name: "背景を切り替える" }).click();
			await expect(page.locator(".hiyori-avatar-background")).toHaveAttribute(
				"data-avatar-state",
				"load-failed",
			);
		}
		expect(errors).toEqual([]);
		expect(await page.locator("canvas").count()).toBe(0);
	} finally {
		await browser.close();
	}
});

declare global {
	interface Window {
		avatarFrameCount: () => number;
	}
}

test("the installed background works with the production content policy and owns one cancellable draw loop", async ({
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
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		await page.addInitScript(() => {
			const pending = new Set<number>();
			const request = window.requestAnimationFrame.bind(window),
				cancel = window.cancelAnimationFrame.bind(window);
			window.requestAnimationFrame = (callback) => {
				const id = request((time) => {
					pending.delete(id);
					callback(time);
				});
				pending.add(id);
				return id;
			};
			window.cancelAnimationFrame = (id) => {
				pending.delete(id);
				cancel(id);
			};
			window.avatarFrameCount = () => pending.size;
		});
		await page.route("http://127.0.0.1/**", (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path.startsWith("/live2d/"))
				return route.fulfill({ path: resolve("web/public", "." + path) });
			if (path === "/fixture.js")
				return route.fulfill({
					contentType: "text/javascript; charset=utf-8",
					body: readFileSync(join(directory, "avatar-lifecycle.fixture.js")),
				});
			return route.fulfill({
				contentType: "text/html; charset=utf-8",
				headers: {
					"Content-Security-Policy":
						"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'",
				},
				body: '<body><div id="root"></div><script src="/fixture.js"></script></body>',
			});
		});
		await page.goto("http://127.0.0.1/__avatar_policy__");
		await page.addStyleTag({
			content: readFileSync(
				join(directory, "avatar-lifecycle.fixture.css"),
				"utf8",
			),
		});
		await expect(page.locator(".hiyori-avatar-background")).toHaveAttribute(
			"data-avatar-state",
			"ready",
		);
		await expect
			.poll(() => page.evaluate(() => window.avatarFrameCount()))
			.toBe(1);
		await page.emulateMedia({ reducedMotion: "reduce" });
		await expect
			.poll(() => page.evaluate(() => window.avatarFrameCount()))
			.toBe(0);
		await page.emulateMedia({ reducedMotion: "no-preference" });
		await expect
			.poll(() => page.evaluate(() => window.avatarFrameCount()))
			.toBe(1);
		for (let i = 0; i < 3; i++) {
			await page.getByRole("button", { name: "背景を切り替える" }).click();
			await expect(page.locator("canvas")).toHaveCount(0);
			await expect
				.poll(() => page.evaluate(() => window.avatarFrameCount()))
				.toBe(0);
			await page.getByRole("button", { name: "背景を切り替える" }).click();
			await expect(page.locator(".hiyori-avatar-background")).toHaveAttribute(
				"data-avatar-state",
				"ready",
			);
			await expect(page.locator("canvas")).toHaveCount(1);
			await expect
				.poll(() => page.evaluate(() => window.avatarFrameCount()))
				.toBe(1);
		}
		expect(
			await page
				.locator('script[src="/live2d/live2dcubismcore.min.js"]')
				.count(),
		).toBe(1);
		expect(errors).toEqual([]);
	} finally {
		await browser.close();
	}
});
