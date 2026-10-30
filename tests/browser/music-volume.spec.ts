import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let directory: string;
test.beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "eumenes-music-volume-"));
	execFileSync(
		"bun",
		[
			"build",
			"tests/browser/music-volume.fixture.tsx",
			"--target=browser",
			"--format=iife",
			'--define=process.env={"NODE_ENV":"production"}',
			"--outdir",
			directory,
		],
		{ stdio: "pipe" },
	);
});
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));

for (const creation of [false, true])
	for (const volume of [0, 0.23])
		test(`music retains volume ${volume} on manual and automatic advance (creation=${creation})`, async ({
			page,
		}) => {
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page.setContent(
				`<body data-creation="${creation}"><audio id="speech"></audio><div id="root"></div></body>`,
			);
			await page.evaluate(() => {
				(document.getElementById("speech") as HTMLAudioElement).volume = 0.65;
				document.addEventListener(
					"play",
					(event) => {
						const audio = event.target as HTMLAudioElement;
						audio.dataset.volumeAtPlay = String(audio.volume);
					},
					true,
				);
			});
			await page.addScriptTag({
				content: readFileSync(
					join(directory, "music-volume.fixture.js"),
					"utf8",
				),
			});
			const player = page.getByRole("region", { name: "音楽プレイヤー" });
			const audio = player.locator("audio");
			await player.getByRole("slider", { name: "音量" }).fill(String(volume));
			await player.getByRole("button", { name: "再生", exact: true }).click();
			await expect(audio).toHaveAttribute(
				"data-volume-at-play",
				String(volume),
			);
			await player.getByRole("button", { name: "次の楽曲" }).click();
			await expect(player.getByRole("heading")).toHaveText("曲B");
			await expect(audio).toHaveAttribute(
				"data-volume-at-play",
				String(volume),
			);
			await player.getByRole("button", { name: "前の楽曲" }).click();
			await expect(player.getByRole("heading")).toHaveText("曲A");
			await expect(audio).toHaveAttribute(
				"data-volume-at-play",
				String(volume),
			);
			await expect
				.poll(() =>
					audio.evaluate((node) =>
						Number.isFinite((node as HTMLAudioElement).duration),
					),
				)
				.toBe(true);
			await audio.evaluate((node) => {
				const media = node as HTMLAudioElement;
				media.currentTime = media.duration - 0.05;
			});
			await expect(player.getByRole("heading")).toHaveText("曲B");
			await expect(audio).toHaveAttribute(
				"data-volume-at-play",
				String(volume),
			);
			expect(
				await audio.evaluate((node) => (node as HTMLAudioElement).volume),
			).toBe(volume);
			expect(
				await page
					.locator("#speech")
					.evaluate((node) => (node as HTMLAudioElement).volume),
			).toBe(0.65);
			expect(errors).toEqual([]);
		});
