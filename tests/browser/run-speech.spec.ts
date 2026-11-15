import { expect, test } from "@playwright/test";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
test.use({ launchOptions: { args: ["--mute-audio"] } });
let directory: string;
test.beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), "eumenes-run-speech-"));
	await build({
		configFile: false,
		plugins: [react()],
		logLevel: "error",
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
		build: {
			outDir: directory,
			emptyOutDir: true,
			lib: {
				entry: resolve("tests/browser/run-speech.fixture.tsx"),
				name: "RunSpeechFixture",
				formats: ["iife"],
				fileName: () => "run-speech.fixture.js",
			},
		},
	});
});
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));
test.beforeEach(async ({ page }) => {
	await page.route("http://127.0.0.1:18709/**", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: '<html lang="ja"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>',
		}),
	);
	await page.goto("http://127.0.0.1:18709/fixture");
	await page.addScriptTag({
		content: readFileSync(join(directory, "run-speech.fixture.js"), "utf8"),
	});
	await page.getByRole("button", { name: "開始" }).click();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.runSpeechFixture.events().filter((e) => e.type === "connected")
						.length,
			),
		)
		.toBe(1);
});
test("real browser audio starts before full adoption, prepares the next clause and plays strictly in order", async ({
	page,
}) => {
	await page.evaluate(() => {
		window.runSpeechFixture.audio(0);
		window.runSpeechFixture.audio(1);
	});
	await expect(page.getByTestId("status")).toHaveText("running");
	await expect(page.getByTestId("subtitle")).toHaveText("句0。");
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.runSpeechFixture.events().filter((e) => e.type === "ack")
						.length,
			),
		)
		.toBe(2);
	const events = await page.evaluate(() => window.runSpeechFixture.events());
	expect(
		events.filter((e) => e.type === "started").map((e) => e.index),
	).toEqual([0, 1]);
	const time = (type: string, index: number) =>
		events.find((e) => e.type === type && e.index === index)!.at;
	expect(time("received", 1)).toBeLessThan(time("ended", 0));
	expect(time("started", 1)).toBeGreaterThanOrEqual(time("ended", 0));
	expect(time("started", 1) - time("ended", 0)).toBeLessThan(250);
	await page.evaluate(() => window.runSpeechFixture.finish());
	await expect(page.getByTestId("playing")).toHaveText("");
	await test.info().attach("timings", {
		body: JSON.stringify(events, null, 2),
		contentType: "application/json",
	});
});
for (const action of ["mute", "fail"] as const)
	test(`${action} interrupts current audio and never plays queued or late audio`, async ({
		page,
	}) => {
		await page.evaluate(() => {
			window.runSpeechFixture.audio(0);
			window.runSpeechFixture.audio(1);
		});
		await expect(page.getByTestId("subtitle")).toHaveText("句0。");
		await page.evaluate((action) => window.runSpeechFixture[action](), action);
		await expect(page.getByTestId("playing")).toHaveText("");
		await page.evaluate(() => window.runSpeechFixture.audio(2));
		await expect(page.getByTestId("subtitle")).toHaveText("");
		const events = await page.evaluate(() => window.runSpeechFixture.events());
		expect(
			events.filter((e) => e.type === "started").map((e) => e.index),
		).toEqual([0]);
		expect(events.some((e) => e.type === "interrupted")).toBe(true);
		expect(events.some((e) => e.type === "closed")).toBe(true);
	});
test("a replacement generation cuts the old clause and discards its queued successor", async ({
	page,
}) => {
	await page.evaluate(() => {
		window.runSpeechFixture.audio(0);
		window.runSpeechFixture.audio(1);
	});
	await expect(page.getByTestId("subtitle")).toHaveText("句0。");
	await page.evaluate(() => {
		window.runSpeechFixture.replace();
		window.runSpeechFixture.audio(2);
	});
	await expect(page.getByTestId("subtitle")).toHaveText("句2。");
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					window.runSpeechFixture.events().filter((e) => e.type === "ack")
						.length,
			),
		)
		.toBe(1);
	const events = await page.evaluate(() => window.runSpeechFixture.events());
	expect(
		events.filter((e) => e.type === "started").map((e) => e.index),
	).toEqual([0, 2]);
	expect(events.filter((e) => e.type === "ack").map((e) => e.index)).toEqual([
		2,
	]);
	await page.evaluate(() => window.runSpeechFixture.finish());
});
