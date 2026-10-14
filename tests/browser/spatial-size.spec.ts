import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createFixture } from "./fixture";
import { settingsFixture } from "../../web/src/domains/settings/sections/fixture";
const fixture = createFixture();
let webPort: number, dir: string;
test.beforeAll(async () => {
	const apiPort = await fixture.port();
	webPort = await fixture.port();
	dir = mkdtempSync(join(tmpdir(), "eumenes-spatial-"));
	await fixture.launch(
		["scripts/toolchain-fixture-server.ts"],
		{
			EUMENES_PORT: String(apiPort),
			EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
		},
		{ ports: [apiPort] },
	);
	await fixture.launchWeb({
		webPort,
		apiPort,
		token: "fixture-token-for-toolchain-browser",
		cacheDir: join(dir, "cache"),
	});
	await fixture.waitUntil(
		async () => (await fetch(`http://127.0.0.1:${webPort}`)).ok,
		{ message: "spatial fixture unavailable" },
	);
});
test.afterAll(async () => {
	await fixture.stopAll();
	rmSync(dir, { recursive: true, force: true });
});

const phase = process.env.SPATIAL_SIZE_PHASE ?? "after";
test("Spatial fills wide and portrait viewports without extra overlay controls", async ({
	page,
}) => {
	test.setTimeout(60000);
	let scatter = 100,
		demo = true;
	await page.route("**/api/settings", async (route) => {
		if (route.request().method() !== "GET") return route.continue();
		const settings = settingsFixture();
		settings.larm.profile = "ornith1.5Strix";
		await route.fulfill({
			json: {
				...settings,
				general: {
					...settings.general,
					background: "spatial",
					spatialPaused: true,
					spatialDemoEnabled: demo,
					spatialDemoHealth: "healthy",
					spatialScatter: scatter,
				},
			},
		});
	});
	const metrics = [];
	for (const viewport of [
		{ width: 2048, height: 862 },
		{ width: 1280, height: 720 },
		{ width: 390, height: 844 },
	]) {
		await page.setViewportSize(viewport);
		await page.goto(`http://127.0.0.1:${webPort}/`);
		const canvas = page.locator(".chat-panel .spatial-background canvas");
		await expect(canvas).toBeVisible();
		await expect(page.locator(".spatial-background")).toHaveAttribute(
			"data-background-state",
			"paused",
		);
		await page.waitForTimeout(1000);
		const picture = await canvas.screenshot({
			path: test.info().outputPath(`${phase}-${viewport.width}.png`),
		});
		const { data, info } = await sharp(picture)
			.removeAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });
		let count = 0,
			minX = info.width,
			minY = info.height,
			maxX = 0,
			maxY = 0;
		for (let y = 0; y < info.height; y++)
			for (let x = 0; x < info.width; x++) {
				const i = (y * info.width + x) * 3;
				if (
					data[i + 2]! - data[i]! > 30 &&
					data[i + 2]! - data[i + 1]! > 15 &&
					data[i + 2]! > 45
				) {
					count++;
					minX = Math.min(minX, x);
					maxX = Math.max(maxX, x);
					minY = Math.min(minY, y);
					maxY = Math.max(maxY, y);
				}
			}
		metrics.push({
			...viewport,
			bluePixels: count,
			blueBounds: { minX, minY, maxX, maxY },
		});
		if (phase === "after") {
			await expect(
				page.getByRole("button", { name: "状態を見る", exact: true }),
			).toHaveCount(0);
			await expect(
				page.getByRole("combobox", { name: "会話モデル", exact: true }),
			).toHaveCount(0);
		}
	}
	scatter = 200;
	await page.reload();
	await page.waitForTimeout(1000);
	await page.locator(".spatial-background canvas").screenshot({
		path: test.info().outputPath(`${phase}-max-scatter-portrait.png`),
	});
	demo = false;
	scatter = 100;
	await page.setViewportSize({ width: 2048, height: 862 });
	await page.reload();
	await page.waitForTimeout(1000);
	await page.locator(".spatial-background canvas").screenshot({
		path: test.info().outputPath(`${phase}-unconfirmed-wide.png`),
	});
	writeFileSync(
		test.info().outputPath(`${phase}-metrics.json`),
		JSON.stringify(metrics, null, 2),
	);
	console.log(JSON.stringify(metrics));
});
