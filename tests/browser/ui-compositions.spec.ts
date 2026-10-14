import { test, expect } from "@playwright/test";
import { createFixture } from "./fixture";
import { openFromLauncher } from "./artifact-launcher";

test.setTimeout(60000);
const fixture = createFixture();
let origin: string;
test.beforeAll(async () => {
	const [apiPort, webPort] = (await fixture.ports(2)) as [number, number];
	origin = `http://127.0.0.1:${webPort}`;
	await fixture.launch(
		["scripts/ui-compositions-fixture-server.ts"],
		{ EUMENES_PORT: String(apiPort), EUMENES_ORIGIN: origin },
		{ ports: [apiPort] },
	);
	await fixture.ready(`http://127.0.0.1:${apiPort}/api/status`);
	await fixture.launchWeb({
		webPort,
		apiPort,
		token: "fixture-token-for-toolchain-browser",
		cacheDir: `/tmp/eumenes-ui-vite-${webPort}`,
	});
	await fixture.ready(origin);
});
test.afterAll(() => fixture.stopAll());

test("survey demo creates a saved OpenUI form with all controls and submission", async ({
	page,
}) => {
	await page.goto(origin);
	await openFromLauncher(page, "UI自由制作");
	const workshop = page.locator(".aui-ui-workspace");
	await expect(workshop).toBeVisible();
	await workshop
		.getByRole("textbox", { name: "1. どんな目的で使いますか？" })
		.fill("来場者から感想を集める");
	await workshop.getByRole("button", { name: "フォーム 入力と送信" }).click();
	await workshop.getByRole("checkbox", { name: "ラジオ選択" }).check();
	await expect(
		workshop.getByRole("textbox", { name: "6. UI制作プロンプト" }),
	).toContainText("来場者から感想を集める");
	await workshop
		.getByRole("textbox", { name: "6. UI制作プロンプト" })
		.fill("手で編集した文章");
	await workshop.getByRole("checkbox", { name: "上品" }).check();
	await expect(
		workshop.getByRole("textbox", { name: "6. UI制作プロンプト" }),
	).toHaveValue("手で編集した文章");
	await workshop.getByRole("button", { name: "選択内容を反映" }).click();
	await expect(
		workshop.getByRole("textbox", { name: "6. UI制作プロンプト" }),
	).toContainText("雰囲気: 上品");
	await workshop.locator(".aui-ui-editor").screenshot({
		path: "spec/verification/ui-compositions-2026-10-14/creation-panel.png",
	});
	await workshop.locator(".aui-ui-header").scrollIntoViewIfNeeded();
	await page.screenshot({
		path: "spec/verification/ui-compositions-2026-10-14/artifact-create.png",
	});
	await workshop.getByRole("button", { name: "アンケートのデモ" }).click();
	await expect(
		workshop.getByRole("tab", { name: "プレビュー" }),
	).toHaveAttribute("aria-selected", "true");
	const preview = workshop.getByRole("region", { name: "作品のプレビュー" });
	await expect(
		preview.getByRole("heading", { name: "来場者アンケート" }).first(),
	).toBeVisible();
	await expect(preview.getByRole("textbox", { name: "お名前" })).toBeVisible();
	await expect(preview.getByRole("radio", { name: "満足" })).toBeVisible();
	await expect(preview.getByRole("checkbox", { name: "技術" })).toBeVisible();
	await expect(preview.getByRole("textbox", { name: "感想" })).toBeVisible();
	await workshop.locator(".aui-ui-preview-panel").screenshot({
		path: "spec/verification/ui-compositions-2026-10-14/survey-demo.png",
	});
	await workshop.locator(".aui-ui-tabs").scrollIntoViewIfNeeded();
	await page.screenshot({
		path: "spec/verification/ui-compositions-2026-10-14/artifact-preview.png",
	});
	await preview.getByRole("textbox", { name: "感想" }).scrollIntoViewIfNeeded();
	await expect(
		workshop.getByRole("button", { name: "編集画面に戻る" }),
	).toBeInViewport();
	await workshop.getByRole("button", { name: "編集画面に戻る" }).click();
	await expect(workshop.getByRole("tab", { name: "作る" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(
		workshop.getByRole("textbox", { name: "6. UI制作プロンプト" }),
	).toContainText("アンケートフォーム");
	await workshop.getByRole("tab", { name: "プレビュー" }).click();
	await preview.getByRole("textbox", { name: "お名前" }).fill("テスト利用者");
	await preview.getByRole("radio", { name: "満足" }).check();
	await preview.getByRole("button", { name: "送信", exact: true }).click();
	await expect(preview.getByText("必須の選択肢を選んでください")).toBeVisible();
	await preview.getByRole("checkbox", { name: "技術" }).check();
	await preview.getByRole("textbox", { name: "感想" }).fill("使いやすいです");
	await preview.getByRole("button", { name: "送信", exact: true }).click();
	await expect(preview.getByText("送信しました")).toBeVisible();
	await page.reload();
	await openFromLauncher(page, "UI自由制作");
	await workshop.getByRole("button", { name: "作品 1" }).click();
	await workshop.getByRole("button", { name: /来場者アンケート/ }).click();
	await expect(preview.getByRole("radio", { name: "満足" })).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(workshop).toBeVisible();
	const overflowing = await workshop.evaluate(
		(element) => element.scrollWidth > element.clientWidth,
	);
	expect(overflowing).toBe(false);
});

test("edited prompt still starts generation from the main action", async ({
	page,
}) => {
	await page.goto(origin);
	await openFromLauncher(page, "UI自由制作");
	const workshop = page.locator(".aui-ui-workspace");
	await workshop
		.getByRole("textbox", { name: "6. UI制作プロンプト" })
		.fill("来場者の意見を集めるフォームを作ってください");
	await workshop.getByRole("button", { name: "UIを生成" }).click();
	await expect(
		workshop.getByRole("tab", { name: "プレビュー" }),
	).toHaveAttribute("aria-selected", "true");
	await expect(
		workshop
			.getByRole("region", { name: "作品のプレビュー" })
			.getByRole("heading", {
				name: "来場者アンケート",
			}),
	).toBeVisible();
	await workshop.getByRole("button", { name: "編集画面に戻る" }).click();
	await expect(
		workshop.getByRole("textbox", { name: "6. UI制作プロンプト" }),
	).toHaveValue("来場者の意見を集めるフォームを作ってください");
});

test("workspace uses the host theme and standard artifact spacing", async ({
	page,
}) => {
	await page.goto(origin);
	await openFromLauncher(page, "UI自由制作");
	const workshop = page.locator(".aui-ui-workspace");
	await expect(workshop).toBeVisible();
	const appearance = () =>
		workshop.evaluate((element) => {
			const editor = element.querySelector(".aui-ui-editor") as HTMLElement;
			const input = element.querySelector("input") as HTMLElement;
			const body = element.closest(".artifact-panel-body") as HTMLElement;
			return {
				background: getComputedStyle(element).backgroundColor,
				foreground: getComputedStyle(element).color,
				editor: getComputedStyle(editor).backgroundColor,
				input: getComputedStyle(input).backgroundColor,
				outerPadding: parseFloat(getComputedStyle(body).paddingLeft),
				sectionGap: parseFloat(
					getComputedStyle(
						element.querySelector(".aui-ui-editor-form") as HTMLElement,
					).gap,
				),
			};
		});
	const light = await appearance();
	await page.evaluate(() => {
		document.documentElement.dataset.theme = "dark";
	});
	const dark = await appearance();
	expect(dark.background).not.toBe(light.background);
	expect(dark.foreground).not.toBe(light.foreground);
	expect(dark.editor).not.toBe(light.editor);
	expect(dark.input).not.toBe(light.input);
	expect(dark.outerPadding).toBeGreaterThanOrEqual(16);
	expect(dark.sectionGap).toBeLessThanOrEqual(16);
	await page.screenshot({
		path: "spec/verification/ui-compositions-2026-10-14/theme-dark-create.png",
	});
	await workshop.getByRole("button", { name: "アンケートのデモ" }).click();
	await expect(
		workshop.getByRole("region", { name: "作品のプレビュー" }),
	).toBeVisible();
	await expect(workshop.locator(".aui-ui-header")).toBeInViewport();
	const preview = workshop.getByRole("region", { name: "作品のプレビュー" });
	await expect(
		preview.getByRole("heading", { name: "来場者アンケート" }),
	).toBeVisible();
	const previewColors = await preview.evaluate((element) => {
		const swatch = document.createElement("div");
		swatch.style.background = "var(--primary)";
		element.append(swatch);
		const primary = getComputedStyle(swatch).backgroundColor;
		swatch.remove();
		return {
			primary,
			submit: getComputedStyle(
				element.querySelector('button[type="submit"]') as HTMLElement,
			).backgroundColor,
		};
	});
	expect(previewColors.submit).toBe(previewColors.primary);
	await page.screenshot({
		path: "spec/verification/ui-compositions-2026-10-14/theme-dark-preview.png",
	});
});
