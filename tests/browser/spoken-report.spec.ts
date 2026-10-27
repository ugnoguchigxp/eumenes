import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Browser route fixture: no application or fixture server is started.
let build: string;
test.beforeAll(() => {
	build = mkdtempSync(join(tmpdir(), "eumenes-spoken-report-"));
	execFileSync(
		"bun",
		[
			"-e",
			`
		import { build } from "vite";
		import react from "@vitejs/plugin-react";
		await build({ configFile: false, define: { "process.env.NODE_ENV": JSON.stringify("production") }, plugins: [react()], worker: { format: "es" }, build: {
			lib: { entry: "tests/browser/fixtures/spoken-report.tsx", formats: ["iife"], name: "SpokenReport", fileName: () => "spoken-report.js" },
			outDir: ${JSON.stringify(build)}, minify: true,
		} });
	`,
		],
		{ stdio: "pipe" },
	);
});
test.afterAll(() => rmSync(build, { recursive: true, force: true }));

for (const mode of ["full", "interrupted", "muted"] as const) {
	test(`a report acknowledges ${mode} only from the real audio lifecycle`, async ({
		page,
	}) => {
		const acknowledgements: Array<{ heard: string; messageId: string }> = [];
		const errors: string[] = [];
		let release = () => {};
		let secondRequested = false;
		const second = new Promise<void>((resolve) => {
			release = resolve;
		});
		page.on("pageerror", (error) => errors.push(error.message));
		await page.addInitScript(() => {
			Reflect.set(window, "audioEnded", 0);
			const original = AudioBufferSourceNode.prototype.start;
			AudioBufferSourceNode.prototype.start = function (...args) {
				this.addEventListener("ended", () =>
					Reflect.set(
						window,
						"audioEnded",
						Number(Reflect.get(window, "audioEnded")) + 1,
					),
				);
				return original.apply(this, args);
			};
		});
		const wav = readFileSync("tests/browser/fixtures/speech.wav");
		await page.route("http://127.0.0.1:4444/**", async (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path === "/api/voice/replay/sentences")
				return route.fulfill({ json: { sentences: ["一。", "二。"] } });
			if (path === "/api/voice/replay/audio") {
				if (route.request().postDataJSON().text === "二。") {
					secondRequested = true;
					await second;
				}
				return route.fulfill({ contentType: "audio/wav", body: wav });
			}
			if (path === "/api/voice/replay/played") {
				acknowledgements.push(route.request().postDataJSON());
				return route.fulfill({ json: { recorded: true } });
			}
			return route.fulfill({
				contentType: "text/html",
				body: '<html><meta charset="utf-8"><div id="root"></div></html>',
			});
		});
		await page.goto("http://127.0.0.1:4444/");
		await page.addScriptTag({ path: join(build, "spoken-report.js") });
		expect(errors).toEqual([]);
		if (mode === "muted")
			await page.getByRole("button", { name: "音量0" }).click();
		await page.getByRole("button", { name: "報告を再生" }).click();
		await expect.poll(() => secondRequested).toBe(true);
		if (mode === "full") {
			await expect
				.poll(() => page.evaluate(() => Reflect.get(window, "audioEnded")))
				.toBe(1);
			expect(acknowledgements).toEqual([]);
			release();
			await expect
				.poll(() => acknowledgements.map((a) => a.heard))
				.toEqual(["full"]);
			expect(await page.evaluate(() => Reflect.get(window, "audioEnded"))).toBe(
				2,
			);
		} else {
			if (mode === "interrupted")
				await page.getByRole("button", { name: "停止", exact: true }).click();
			await expect
				.poll(() => acknowledgements.map((a) => a.heard))
				.toEqual(["none"]);
			release();
		}
		expect(acknowledgements[0]?.messageId).toBe("report");
		await expect(page.getByRole("alert")).toHaveCount(0);
		expect(errors).toEqual([]);
	});
}
