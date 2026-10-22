import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// Component acceptance: no HTTP server or live provider is started.
let directory: string;
test.beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "eumenes-pipeline-handoff-"));
	execFileSync(
		"bun",
		[
			"build",
			"tests/browser/pipeline-handoff.fixture.tsx",
			"--target=browser",
			"--format=iife",
			"--outdir",
			directory,
		],
		{ stdio: "pipe" },
	);
});
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));
async function open(page: Page) {
	await page.setContent(
		'<html data-theme="dark"><body><div id="root"></div></body></html>',
	);
	const audio = `data:audio/ogg;base64,${readFileSync("tests/browser/fixtures/silence.opus").toString("base64")}`;
	await page.evaluate(
		({ id, audio }) => {
			if (!crypto.randomUUID)
				Object.defineProperty(crypto, "randomUUID", { value: () => id });
			window.pipelineHandoff = { events: [], audio, playCalls: 0 };
			const original = HTMLMediaElement.prototype.play;
			HTMLMediaElement.prototype.play = function () {
				window.pipelineHandoff.playCalls++;
				return original.call(this);
			};
		},
		{ id: randomUUID(), audio },
	);
	for (const name of readdirSync(directory).filter((file) =>
		file.endsWith(".css"),
	))
		await page.addStyleTag({
			content: readFileSync(join(directory, name), "utf8"),
		});
	await page.addStyleTag({
		content:
			"html,body,#root{margin:0;height:100%;overflow:hidden}body{background:var(--background);color:var(--foreground)}.fixture-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,736px);height:100%}.fixture-chat{padding:24px}.fixture-chat textarea{width:100%}.fixture-artifact{display:grid;grid-template-rows:auto minmax(0,1fr);min-width:0;border-left:1px solid var(--border)}.fixture-artifact>header{padding:12px;border-bottom:1px solid var(--border)}.fixture-artifact-body{padding:8px;overflow:auto;min-width:0}.pipeline-studio{min-width:0}@media(max-width:800px){.fixture-layout{grid-template-columns:minmax(0,1fr)}.fixture-chat{display:none}}",
	});
	await page.addScriptTag({
		content: readFileSync(
			join(
				directory,
				readdirSync(directory).find((file) => file.endsWith(".js"))!,
			),
			"utf8",
		),
	});
	await expect(
		page.getByRole("button", { name: "渡すものを編集" }).last(),
	).toBeVisible();
}
async function edit(page: Page) {
	await page.getByRole("button", { name: "渡すものを編集" }).last().click();
	await expect(page.getByRole("dialog")).toBeVisible();
}

test("artifact modal stays small and separate pickers preserve drafts, media refs and full body", async ({
	page,
}, testInfo) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.setViewportSize({ width: 1300, height: 850 });
	await open(page);
	await edit(page);
	const modal = page.getByRole("dialog");
	expect((await modal.boundingBox())!.width).toBeLessThanOrEqual(402);
	expect((await modal.boundingBox())!.height).toBeLessThan(400);
	await page
		.getByRole("textbox", { name: "会話の入力" })
		.fill("会話は操作できます");
	expect(
		await page
			.getByRole("button", { name: /画像を選ぶ/ })
			.evaluate((node) => getComputedStyle(node).color),
	).toBe(await modal.evaluate((node) => getComputedStyle(node).color));
	await page.screenshot({ path: testInfo.outputPath("handoff-modal.png") });
	await page.getByLabel("参照元").selectOption("body");
	const body = "  本文\n${inputs.topic}\n ";
	await page.getByLabel("渡す本文").fill(body);
	await page.getByRole("button", { name: "この本文を選ぶ" }).click();
	await page.getByLabel("参照元").selectOption("saved");
	await page.getByRole("button", { name: /画像を選ぶ/ }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.getByRole("img", { name: "保存画像1" })).toBeVisible();
	await page
		.getByRole("img", { name: "保存画像1" })
		.evaluate((image) => (image as HTMLImageElement).decode());
	await page.screenshot({ path: testInfo.outputPath("handoff-images.png") });
	await page.getByRole("button", { name: "保存画像1を選ぶ" }).click();
	await page.getByRole("button", { name: "この画像を使う" }).click();
	await expect(modal).toBeVisible();
	await page.getByRole("button", { name: /楽曲を選ぶ/ }).click();
	await page.getByText("静かな午後").click();
	expect(await page.evaluate(() => window.pipelineHandoff.playCalls)).toBe(0);
	await page.getByRole("button", { name: "再生", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => window.pipelineHandoff.playCalls))
		.toBe(1);
	await page.screenshot({ path: testInfo.outputPath("handoff-music.png") });
	await page.getByRole("button", { name: "この楽曲を使う" }).click();
	await expect(page.locator("audio")).toHaveCount(0);
	await page.getByLabel("参照元").selectOption("prompt");
	await page.getByLabel("どのプロンプトを渡すか").selectOption("step:compose");
	await page.getByRole("button", { name: "このプロンプトを選ぶ" }).click();
	await page.getByRole("button", { name: "反映", exact: true }).click();
	await expect(modal).toHaveCount(0);
	const materials = await page.evaluate(
		() =>
			JSON.parse(
				String(
					window.pipelineHandoff.events.find(
						(e) => e.action === "pipeline-source-apply",
					)!.values.text,
				),
			).steps[1].materials,
	);
	expect(materials).toEqual([
		{ kind: "text", text: body },
		{ kind: "image", id: "image-1", title: "保存画像1" },
		{ kind: "music", id: "track-1", title: "静かな午後" },
		{ kind: "prompt", stepId: "compose" },
	]);
	await edit(page);
	await page.getByRole("button", { name: /画像を選ぶ/ }).click();
	await page.getByRole("button", { name: "保存画像2を選ぶ" }).click();
	await page.getByRole("button", { name: "キャンセル", exact: true }).click();
	await page.getByRole("button", { name: "キャンセル", exact: true }).click();
	expect(
		await page.evaluate(
			() =>
				window.pipelineHandoff.events.filter(
					(e) => e.action === "pipeline-source-apply",
				).length,
		),
	).toBe(1);
	expect(errors).toEqual([]);
});

test("modal and pickers fit narrow artifacts with keyboard return", async ({
	page,
}) => {
	await open(page);
	for (const width of [736, 420, 320]) {
		await page.setViewportSize({ width, height: 750 });
		await edit(page);
		await page.getByLabel("参照元").selectOption("prompt");
		expect(
			await page
				.locator(".fixture-artifact-body")
				.evaluate((node) => node.scrollWidth <= node.clientWidth),
		).toBe(true);
		await page.getByLabel("参照元").selectOption("saved");
		await page.getByRole("button", { name: /画像を選ぶ/ }).click();
		expect(
			await page
				.locator(".fixture-artifact-body")
				.evaluate((node) => node.scrollWidth <= node.clientWidth),
		).toBe(true);
		await page.getByRole("button", { name: "戻る", exact: true }).click();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toHaveCount(0);
	}
});

test("choosing another track during preview never starts it automatically", async ({
	page,
}) => {
	await open(page);
	await edit(page);
	await page.getByRole("button", { name: /楽曲を選ぶ/ }).click();
	await page.getByText("静かな午後").click();
	await page.getByRole("button", { name: "再生", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "一時停止", exact: true }),
	).toBeVisible();
	await page.getByText("夜の余韻").click();
	await expect(
		page.getByRole("button", { name: "再生", exact: true }),
	).toBeVisible();
	expect(await page.evaluate(() => window.pipelineHandoff.playCalls)).toBe(1);
});
