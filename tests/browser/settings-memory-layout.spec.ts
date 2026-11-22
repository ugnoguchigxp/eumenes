import { expect, test, type Locator } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let directory: string;
test.use({ launchOptions: { args: ["--mute-audio"] } });
test.beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "eumenes-memory-layout-"));
	execFileSync("bun", [
		"build",
		"tests/browser/settings-memory-layout.fixture.tsx",
		"--target=browser",
		"--format=esm",
		"--define",
		'process.env={"NODE_ENV":"production"}',
		"--outdir",
		directory,
	]);
});
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function expectOneLine(cell: Locator) {
	await expect(cell).toBeVisible();
	const lines = await cell.evaluate((node) => {
		const range = document.createRange();
		range.selectNodeContents(node);
		return new Set(Array.from(range.getClientRects(), (rect) => rect.top)).size;
	});
	expect(lines).toBe(1);
}

test("memory metadata stays readable beside long content", async ({ page }) => {
	page.on("pageerror", (error) => {
		throw error;
	});
	await page.setViewportSize({ width: 760, height: 900 });
	await page.route("https://memory-layout.test/", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: '<!doctype html><html lang="ja" data-theme="dark"><div id="root"></div></html>',
		}),
	);
	await page.goto("https://memory-layout.test/");
	await page.addStyleTag({
		path: join(directory, "settings-memory-layout.fixture.css"),
	});
	await page.addScriptTag({
		path: join(directory, "settings-memory-layout.fixture.js"),
		type: "module",
	});
	const notes = page.getByRole("table", { name: "最近の活動・メモ（短期）" });
	const items = page.getByRole("table", { name: "いつも使う記憶（長期）" });
	const history = page.getByRole("table", {
		name: "記憶の履歴（置き換え・撤回済みなど）",
	});
	const check = async (table: Locator, kind: string, source: string) => {
		await expectOneLine(table.getByRole("cell", { name: kind, exact: true }));
		const origin = table.getByRole("cell", { name: source, exact: true });
		await expectOneLine(origin);
		const content = table.getByRole("columnheader", { name: /^内容/ });
		expect((await content.boundingBox())!.width).toBeGreaterThan(
			(await origin.boundingBox())!.width,
		);
	};
	await expectOneLine(
		notes.getByRole("columnheader", { name: "記録のしかた" }),
	);
	await check(notes, "未解決", "会話から自動で記録");
	expect(
		await notes
			.locator("..")
			.evaluate((node) => node.scrollWidth - node.clientWidth),
	).toBeLessThanOrEqual(1);
	await check(items, "本人の事実", "会話から自動で記憶");
	await page.getByRole("tab", { name: "記憶の履歴" }).click();
	await check(history, "本人の事実", "会話から自動で記憶");

	await page.setViewportSize({ width: 390, height: 800 });
	await check(history, "本人の事実", "会話から自動で記憶");
	await page.getByRole("tab", { name: "会話で使う記憶" }).click();
	await check(items, "本人の事実", "会話から自動で記憶");
	await check(notes, "未解決", "会話から自動で記録");
	for (const table of [items, notes]) {
		expect(
			await table.locator("..").evaluate((node) => {
				node.scrollLeft = node.scrollWidth;
				return node.scrollLeft;
			}),
		).toBeGreaterThan(0);
	}
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
		390,
	);
});
