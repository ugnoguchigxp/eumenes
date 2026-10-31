import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let directory: string;
test.beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "eumenes-music-autoplay-"));
	execFileSync(
		"bun",
		[
			"build",
			"tests/browser/music-autoplay.fixture.tsx",
			"--target=browser",
			"--format=iife",
			'--define=process.env={"NODE_ENV":"development"}',
			"--outdir",
			directory,
		],
		{ stdio: "pipe" },
	);
});
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));

for (const viewport of [
	{ width: 720, height: 660 },
	{ width: 720, height: 480 },
	{ width: 390, height: 844 },
])
	for (const history of [false, true])
		test(`completed music plays once at the panel bottom; saved history stays paused (${viewport.width}x${viewport.height}, history=${history})`, async ({
			page,
		}) => {
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page.setViewportSize(viewport);
			// Loopback is a secure context for the normal event IDs; no server is started.
			await page.route("http://127.0.0.1/__music_fixture__", (route) =>
				route.fulfill({
					contentType: "text/html",
					body: `<body data-history="${history}" data-plays="0"><div id="root"></div></body>`,
				}),
			);
			await page.goto("http://127.0.0.1/__music_fixture__");
			await page.addStyleTag({
				content: readFileSync(
					join(directory, "music-autoplay.fixture.css"),
					"utf8",
				),
			});
			await page.evaluate(() => {
				document.addEventListener(
					"play",
					() => {
						document.body.dataset.plays = String(
							Number(document.body.dataset.plays) + 1,
						);
						const panel = document
							.querySelector(".artifact-panel-body")!
							.getBoundingClientRect();
						const player = document
							.querySelector(".music-player")!
							.getBoundingClientRect();
						document.body.dataset.playGeometry = JSON.stringify({
							panelBottom: panel.bottom,
							playerBottom: player.bottom,
						});
					},
					true,
				);
			});
			await page.addScriptTag({
				content: readFileSync(
					join(directory, "music-autoplay.fixture.js"),
					"utf8",
				),
			});
			const player = page.getByRole("region", { name: "音楽プレイヤー" });
			await expect(
				page.getByRole("textbox", { name: "音楽作成プロンプト" }),
			).toBeVisible();
			const panelOverflow = await page
				.locator(".artifact-panel-body")
				.evaluate((e) => ({
					height: e.clientHeight,
					scrollHeight: e.scrollHeight,
				}));
			expect(
				panelOverflow.scrollHeight,
				JSON.stringify(panelOverflow),
			).toBeLessThanOrEqual(panelOverflow.height + 1);
			if (history) {
				await expect(
					player.getByRole("button", { name: "再生", exact: true }),
				).toBeVisible();
				await expect(page.locator("body")).toHaveAttribute("data-plays", "0");
				await player.getByRole("button", { name: "再生", exact: true }).click();
			} else {
				await page
					.getByRole("checkbox", { name: "アフロビート", exact: true })
					.focus();
				await page
					.getByRole("textbox", { name: "音楽作成プロンプト" })
					.fill("短いピアノ音楽");
				await page.getByRole("spinbutton").fill("15");
				await page
					.getByRole("button", { name: "編集内容を使う", exact: true })
					.click();
				await page
					.getByRole("button", { name: "楽曲を生成", exact: true })
					.click();
				await expect(
					page.getByRole("button", { name: "生成を取り消す" }),
				).toBeVisible();
				await page.getByRole("button", { name: "完成通知" }).click();
			}
			await expect(
				player.getByRole("button", { name: "一時停止", exact: true }),
			).toBeVisible();
			await expect
				.poll(() =>
					player
						.locator("audio")
						.evaluate((node) => (node as HTMLAudioElement).currentTime),
				)
				.toBeGreaterThan(0.1);
			await expect(page.locator("body")).toHaveAttribute("data-plays", "1");
			const atPlay = JSON.parse(
				(await page.locator("body").getAttribute("data-play-geometry"))!,
			);
			expect(
				Math.abs(atPlay.panelBottom - atPlay.playerBottom),
				JSON.stringify(atPlay),
			).toBeLessThanOrEqual(2);
			await expect(
				page.getByRole("button", { name: "楽曲を生成", exact: true }),
			).toBeEnabled();
			await page.screenshot({
				path: `/tmp/eumenes-music-layout-${viewport.width}-${viewport.height}-${history}.png`,
			});
			const geometry = await page.evaluate(() => {
				const panel = document
					.querySelector(".artifact-panel-body")!
					.getBoundingClientRect();
				const workspace = document
					.querySelector(".music-workspace")!
					.getBoundingClientRect();
				const player = document
					.querySelector(".music-player")!
					.getBoundingClientRect();
				return {
					panelBottom: panel.bottom,
					workspaceBottom: workspace.bottom,
					playerBottom: player.bottom,
					playerTop: player.top,
				};
			});
			expect(
				Math.abs(geometry.panelBottom - geometry.playerBottom),
				JSON.stringify(geometry),
			).toBeLessThanOrEqual(2);
			await page.getByRole("button", { name: "完成通知" }).click();
			await expect
				.poll(() =>
					player
						.locator("audio")
						.evaluate((node) => (node as HTMLAudioElement).currentTime),
				)
				.toBeGreaterThan(0.3);
			await expect(page.locator("body")).toHaveAttribute("data-plays", "1");
			expect(errors).toEqual([]);
		});
