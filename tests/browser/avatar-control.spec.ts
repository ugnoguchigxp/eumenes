import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {} from "./avatar-control.fixture";
import type {} from "./avatar-replay.fixture";
import type {} from "./avatar-transition.fixture";
import type { AvatarCue } from "../../web/src/domains/avatar";
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
 const result = await Bun.build({entrypoints:["tests/browser/avatar-control.fixture.ts", "tests/browser/avatar-lifecycle.fixture.tsx", "tests/browser/avatar-replay.fixture.tsx", "tests/browser/avatar-transition.fixture.ts"],outdir:${JSON.stringify(directory)},target:"browser",format:"iife",define:{"process.env.NODE_ENV":JSON.stringify("production")},plugins:[{name:"worklet-url",setup(b){
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

test("real Hiyori blends the displayed pose at start, return and interruption", async ({
	playwright,
}, testInfo) => {
	const motionFiles = ["Hiyori_m07.motion3.json", "Hiyori_m08.motion3.json"];
	const modelFiles = [
		"Hiyori.moc3",
		...motionFiles.map((file) => "motions/" + file),
	];
	test.skip(
		modelFiles.some((file) => !existsSync("web/public/live2d/hiyori/" + file)),
		"Install the local Hiyori model and its official motion files.",
	);
	const browser = await playwright.chromium.launch({
		args: [
			"--mute-audio",
			"--use-gl=angle",
			"--use-angle=swiftshader",
			"--enable-unsafe-swiftshader",
		],
	});
	const page = await browser.newPage({ viewport: { width: 480, height: 500 } });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		await page.addInitScript(() => {
			Math.random = () => 0;
		});
		await page.route("http://127.0.0.1/**", (route) => {
			const path = new URL(route.request().url()).pathname;
			if (
				path.includes("/motions/") &&
				!motionFiles.some((file) => path.endsWith("/" + file))
			)
				return route.fulfill({ status: 404 });
			if (path.startsWith("/live2d/"))
				return route.fulfill({ path: resolve("web/public", "." + path) });
			if (path === "/fixture.js")
				return route.fulfill({
					contentType: "text/javascript",
					path: join(directory, "avatar-transition.fixture.js"),
				});
			return route.fulfill({
				contentType: "text/html",
				body: '<body style="margin:0;background:#182030"><div id="avatar" style="width:480px;height:500px"></div><script src="/fixture.js"></script></body>',
			});
		});
		await page.goto("http://127.0.0.1/__hiyori_transition__");
		await expect
			.poll(() => page.evaluate(() => window.hiyoriTransitionTest?.loaded()))
			.toBe(2);
		const trace = await page.evaluate(() => {
			const { render } = window.hiyoriTransitionTest;
			const scene = (
				end: number,
				cue: (frame: number) => AvatarCue | null,
				mouth = 0,
			) =>
				Array.from({ length: end + 1 }, (_, frame) =>
					render(frame / 24, cue(frame), mouth),
				);
			const joy = (key: string): AvatarCue => ({
				key,
				motion: "joyful",
				emotion: "joy",
			});
			const surprise = (key: string): AvatarCue => ({
				key,
				motion: "surprised",
				emotion: "surprise",
			});
			const early = scene(92, (frame) => (frame >= 24 ? joy("early") : null));
			const late = scene(110, (frame) => (frame >= 78 ? joy("late") : null));
			const switched = scene(66, (frame) => {
				if (frame >= 42) return surprise("switch");
				return frame >= 24 ? joy("before-switch") : null;
			});
			const stopped = scene(54, (frame) =>
				frame >= 24 && frame < 33 ? joy("stop") : null,
			);
			const stoppedBeforeSwitch = scene(54, (frame) =>
				frame >= 24 && frame < 26 ? joy("stop-before-switch") : null,
			);
			const stillBefore = scene(42, (frame) =>
				frame >= 24 ? joy("before-still") : null,
			).at(-1)!;
			const still = render(0, null);
			const idle = scene(92, () => null);
			const blinking = scene(
				78,
				(frame) => (frame >= 60 ? surprise("blink") : null),
				0.35,
			);
			const fallback = scene(42, (frame) =>
				frame >= 24
					? { key: "no-clip", motion: "greeting", emotion: "admiration" }
					: null,
			);
			return {
				early,
				late,
				switched,
				stopped,
				stoppedBeforeSwitch,
				stillBefore,
				still,
				idle,
				blinking,
				fallback,
			};
		});
		await testInfo.attach("hiyori-frame-parameters", {
			body: JSON.stringify(trace),
			contentType: "application/json",
		});
		const isArms = (arms: number[], a: number, b: number) =>
			arms[0] === a && arms[1] === b;
		const invalidArmFrame = Object.values(trace)
			.flat()
			.find(({ arms }) => !isArms(arms, 1, 0) && !isArms(arms, 0, 1));
		expect(invalidArmFrame?.arms).toBeUndefined();

		expect(trace.early[24]!.pose).toEqual(trace.early[23]!.pose);
		expect(trace.early[24]!.arms).toEqual([1, 0]);
		expect(trace.early[28]!.arms).toEqual([1, 0]);
		expect(trace.early[32]!.arms).toEqual([0, 1]);
		expect(trace.early[42]!.arms).toEqual([0, 1]);
		expect(trace.early[42]!.smile).toBeGreaterThan(0.25);
		for (let age = 14; age <= 32; age++)
			trace.early[24 + age]!.pose.forEach((value, index) =>
				expect(value).toBeCloseTo(trace.late[78 + age]!.pose[index]!, 4),
			);

		// The 2.1-second joy clip ends before its text cue expires.
		expect(trace.early[76]!.pose).toEqual(trace.early[75]!.pose);
		expect(trace.early[76]!.arms).toEqual([0, 1]);
		expect(trace.early[92]!.pose).toEqual(trace.idle[92]!.pose);
		expect(trace.early[92]!.arms).toEqual([1, 0]);
		expect(trace.switched[42]!.pose).toEqual(trace.switched[41]!.pose);
		expect(trace.switched[42]!.arms).toEqual(trace.switched[41]!.arms);
		expect(trace.switched[55]!.arms).toEqual([1, 0]);
		expect(
			Math.max(
				...trace.switched
					.slice(42, 55)
					.map((frame) => Math.abs(frame.pose[0]!)),
			),
		).toBeLessThan(0.01);
		expect(trace.stopped[33]!.pose).toEqual(trace.stopped[32]!.pose);
		expect(trace.stopped[32]!.arms).toEqual([0, 1]);
		expect(trace.stopped[33]!.arms).toEqual([0, 1]);
		expect(trace.stopped[54]!.pose).toEqual(trace.idle[54]!.pose);
		expect(trace.stopped[54]!.arms).toEqual([1, 0]);
		expect(
			trace.stoppedBeforeSwitch.every(({ arms }) => isArms(arms, 1, 0)),
		).toBe(true);
		expect(trace.stillBefore.arms).toEqual([0, 1]);
		expect(trace.still.arms).toEqual([1, 0]);
		expect(trace.blinking[74]!.eye).toBeLessThan(0.02);
		expect(trace.blinking[74]!.mouth).toBeCloseTo(0.35, 4);
		expect(trace.fallback[42]!.pose).toEqual(trace.idle[42]!.pose);
		expect(trace.fallback[42]!.smile).toBeGreaterThan(0.4);
		expect(trace.fallback[42]!.arms).toEqual([1, 0]);
		expect(errors).toEqual([]);
	} finally {
		await browser.close();
	}
});

test("new messages and replay drive the real face and mouth, then return to the conversation phase", async ({
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
	const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		await page.route("http://127.0.0.1/**", (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path.startsWith("/live2d/"))
				return route.fulfill({ path: resolve("web/public", "." + path) });
			if (path === "/api/voice/replay/sentences")
				return route.fulfill({ json: { sentences: ["確認用の発話です。"] } });
			if (path === "/api/voice/replay/audio")
				return route.fulfill({
					path: resolve(
						"web/src/domains/settings/sounds/task-completed-en-male.wav",
					),
					contentType: "audio/wav",
					headers: { "X-Avatar-Motion": "joyful", "X-Avatar-Emotion": "joy" },
				});
			if (path === "/fixture.js")
				return route.fulfill({
					contentType: "text/javascript; charset=utf-8",
					body: readFileSync(join(directory, "avatar-replay.fixture.js")),
				});
			return route.fulfill({
				contentType: "text/html; charset=utf-8",
				body: '<body><div id="root"></div><script src="/fixture.js"></script></body>',
			});
		});
		await page.goto("http://127.0.0.1/__avatar_replay__");
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
		const stats = () => page.evaluate(() => window.avatarReplayStats());
		await expect
			.poll(async () => (await stats())?.ParamBrowLY)
			.toBeGreaterThan(0.2);
		await expect(page.getByRole("img", { name: "喜び" })).toHaveCount(1);
		await expect(page.getByLabel("会話の表情")).toHaveText("idle");
		await page.getByRole("button", { name: "新しい発言を受け取る" }).click();
		await expect(page.getByRole("img", { name: "喜び" })).toHaveCount(2);
		await expect(page.getByLabel("会話の表情")).toHaveText("joy");
		await expect
			.poll(async () => (await stats())?.ParamEyeLSmile)
			.toBeGreaterThan(0.25);
		if (existsSync("web/public/live2d/hiyori/motions/Hiyori_m08.motion3.json"))
			await expect
				.poll(async () => (await stats())?.ParamBodyAngleY, { intervals: [50] })
				.toBeGreaterThan(2);
		expect((await stats())?.ParamMouthOpenY).toBe(0);
		await expect(page.getByLabel("会話の表情")).toHaveText("idle");
		await page.getByRole("button", { name: "読み上げる", exact: true }).click();
		await expect(page.getByLabel("発話の状態")).toHaveText("joyful");
		await expect(page.getByLabel("会話の表情")).toHaveText("joy");
		await expect
			.poll(async () => (await stats())?.ParamMouthOpenY, { intervals: [50] })
			.toBeGreaterThan(0.1);
		await expect
			.poll(async () => (await stats())?.ParamEyeLSmile, { intervals: [50] })
			.toBeGreaterThan(0.3);
		await page.screenshot({ path: "test-results/hiyori-replay-speaking.png" });
		await page
			.getByRole("button", { name: "読み上げを止める", exact: true })
			.click();
		await expect.poll(async () => (await stats())?.ParamMouthOpenY).toBe(0);
		await expect
			.poll(async () => (await stats())?.ParamEyeLSmile)
			.toBeLessThan(0.01);
		await expect
			.poll(async () => (await stats())?.ParamBrowLY)
			.toBeGreaterThan(0.2);
		await page.getByRole("button", { name: "読み上げる", exact: true }).click();
		await expect(page.getByLabel("発話の状態")).toHaveText("joyful");
		await expect(page.getByLabel("発話の状態")).toHaveText("idle");
		await expect.poll(async () => (await stats())?.ParamMouthOpenY).toBe(0);
		await page.getByRole("button", { name: "待機する", exact: true }).click();
		const before = await stats();
		const framing = await page.evaluate(() => window.avatarReplayMatrix());
		expect(framing).toHaveLength(16);
		await expect
			.poll(async () =>
				Math.abs((await stats())!.ParamAngleX! - before!.ParamAngleX!),
			)
			.toBeGreaterThan(8);
		expect(Math.abs((await stats())!.ParamBodyAngleX!)).toBeLessThanOrEqual(
			2.5,
		);
		expect(Math.abs((await stats())!.ParamBodyAngleZ!)).toBeLessThanOrEqual(
			1.5,
		);
		expect(await page.evaluate(() => window.avatarReplayMatrix())).toEqual(
			framing,
		);
		await expect
			.poll(async () => (await stats())?.ParamMouthForm)
			.toBeGreaterThan(0.1);
		await expect
			.poll(async () => (await stats())?.ParamEyeLSmile)
			.toBeGreaterThan(0.1);
		expect((await stats())?.ParamMouthOpenY).toBe(0);
		await page.screenshot({ path: "test-results/hiyori-idle-after.png" });
		expect(errors).toEqual([]);
	} finally {
		await browser.close();
	}
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
