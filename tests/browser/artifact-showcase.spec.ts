import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let webPort: number;
const processes: ChildProcess[] = [];
let dir: string;
async function port() {
	const server = createServer();
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const result = (server.address() as AddressInfo).port;
	await new Promise<void>((r) => server.close(() => r()));
	return result;
}
test.beforeAll(async () => {
	const apiPort = await port();
	webPort = await port();
	dir = mkdtempSync(join(tmpdir(), "eumenes-artifact-"));
	processes.push(
		spawn("bun", ["scripts/toolchain-fixture-server.ts"], {
			env: {
				...process.env,
				EUMENES_PORT: String(apiPort),
				EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
			},
			stdio: "ignore",
		}),
	);
	processes.push(
		spawn("bun", ["run", "dev:web", "--port", String(webPort)], {
			env: {
				...process.env,
				EUMENES_PROXY_URL: `http://127.0.0.1:${apiPort}`,
				EUMENES_API_TOKEN: "fixture-token-for-toolchain-browser",
				EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
				EUMENES_VITE_CACHE_DIR: join(dir, "vite-cache"),
				LARM_API_TOKEN: "",
			},
			stdio: "ignore",
		}),
	);
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(`http://127.0.0.1:${webPort}`)).ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("showcase fixture unavailable");
});
test.afterAll(async () => {
	for (const process of processes) process.kill("SIGTERM");
	await new Promise((r) => setTimeout(r, 200));
	for (const process of processes)
		if (process.exitCode === null) process.kill("SIGKILL");
	rmSync(dir, { recursive: true, force: true });
});
test.beforeEach(async ({ page }, testInfo) => {
	await page.addInitScript(() =>
		Object.defineProperty(window, "WebGL2RenderingContext", {
			value: undefined,
		}),
	);
	const startupErrors: string[] = [];
	page.on("pageerror", (error) => startupErrors.push(error.message));
	await page.goto(`http://127.0.0.1:${webPort}`);
	await expect(page.locator("#root"), JSON.stringify(startupErrors))
		.not.toBeEmpty()
		.catch((error) => {
			throw new Error(
				`${error.message} startup: ${JSON.stringify(startupErrors)}`,
			);
		});
	expect(startupErrors).toEqual([]);
	if (testInfo.tags.includes("@load-failure")) return;
	await page
		.getByRole("button", { name: "UIショーケース", exact: true })
		.click();
	await expect(
		page.getByRole("region", { name: "UIショーケース", exact: true }),
	).toBeVisible();
	await expect(page.locator("[data-openui-devtools-auto-mount]")).toHaveCount(
		0,
	);
	await page.getByText("開発用の確認", { exact: true }).click();
	await page.getByText("定義を編集", { exact: true }).click();
	await page.getByText("試用条件を変更", { exact: true }).click();
	await page
		.locator("summary")
		.filter({ hasText: /^操作履歴/ })
		.click();
});

test(
	"failed showcase import preserves the conversation and offers reload recovery",
	{ tag: "@load-failure" },
	async ({ page }) => {
		const input = page.getByRole("textbox", {
			name: "メッセージ",
			exact: true,
		});
		await input.fill("読み込み失敗でも残す下書き");
		const moduleUrl =
			"**/src/components/domains/artifact/ArtifactShowcase.tsx*";
		await page.route(moduleUrl, (route) => route.abort());
		await page
			.getByRole("button", { name: "UIショーケース", exact: true })
			.click();
		const artifact = page.getByRole("complementary", {
			name: "アーティファクト",
			exact: true,
		});
		await expect(artifact.getByRole("alert")).toContainText(
			"ショーケースを読み込めませんでした",
		);
		await expect(input).toBeVisible();
		await expect(input).toHaveValue("読み込み失敗でも残す下書き");
		await page.unroute(moduleUrl);
		await artifact
			.getByRole("button", { name: "画面を再読み込み", exact: true })
			.click();
		await page
			.getByRole("button", { name: "UIショーケース", exact: true })
			.click();
		await expect(
			page.getByRole("region", { name: "UIショーケース", exact: true }),
		).toContainText("入力と操作の見本");
	},
);

test("workspace boundary resizes with drag and keyboard, preserves drafts and disappears with the last artifact", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	const handle = page.getByRole("separator", {
		name: "会話とアーティファクトのサイズを調整",
	});
	const chat = page.getByRole("region", { name: "会話", exact: true });
	const artifact = page.getByRole("complementary", {
		name: "アーティファクト",
		exact: true,
	});
	const input = page.getByRole("textbox", { name: "メッセージ", exact: true });
	await input.fill("サイズ変更中も残す下書き");
	const sample = page.getByLabel("入力の見本");
	await sample.fill("アーティファクトの下書き");
	await expect(handle).toHaveAttribute("aria-orientation", "vertical");
	const initialWidth = (await chat.boundingBox())!.width;
	const box = (await handle.boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 + 180, box.y + box.height / 2, {
		steps: 8,
	});
	await page.mouse.up();
	expect((await chat.boundingBox())!.width).toBeCloseTo(initialWidth + 180, 0);
	expect((await artifact.boundingBox())!.width).toBeCloseTo(
		initialWidth - 180,
		0,
	);
	await expect(page.locator(".workspace-layout")).not.toHaveAttribute(
		"data-resizing",
		"true",
	);
	await expect(input).toHaveValue("サイズ変更中も残す下書き");
	await expect(sample).toHaveValue("アーティファクトの下書き");
	await handle.focus();
	await page.keyboard.press("Home");
	await page.keyboard.press("ArrowLeft");
	await expect(handle).toHaveAttribute("aria-valuenow", "25");
	await page.keyboard.press("End");
	await page.keyboard.press("ArrowRight");
	await expect(handle).toHaveAttribute("aria-valuenow", "75");
	await page.keyboard.press("Enter");
	await expect(handle).toHaveAttribute("aria-valuenow", "50");
	await page.keyboard.press("Shift+ArrowRight");
	await expect(handle).toHaveAttribute("aria-valuenow", "60");
	await handle.dblclick();
	await expect(handle).toHaveAttribute("aria-valuenow", "50");
	const edge = (await handle.boundingBox())!;
	await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
	await page.mouse.down();
	await page.mouse.move(1280, edge.y + edge.height / 2);
	await page.mouse.up();
	await expect(handle).toHaveAttribute("aria-valuenow", "75");
	const screenshotDir = resolve("spec/verification/openui-artifact");
	await page.screenshot({
		path: join(screenshotDir, "resizable-workspace-desktop.png"),
	});
	await page
		.getByRole("button", { name: "UIショーケースを閉じる", exact: true })
		.click();
	await expect(handle).toHaveCount(0);
	expect((await chat.boundingBox())!.width).toBe(1280);
	await expect(input).toHaveValue("サイズ変更中も残す下書き");
	await page
		.getByRole("button", { name: "UIショーケース", exact: true })
		.click();
	await expect(handle).toHaveAttribute("aria-valuenow", "75");
});

test("stacked boundary adjusts height and retains independent widths across viewport changes", async ({
	page,
}) => {
	const handle = page.getByRole("separator", {
		name: "会話とアーティファクトのサイズを調整",
	});
	const chat = page.getByRole("region", { name: "会話", exact: true });
	await page.setViewportSize({ width: 1280, height: 900 });
	await handle.focus();
	await page.keyboard.press("Shift+ArrowRight");
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(handle).toHaveAttribute("aria-orientation", "horizontal");
	await expect(handle).toHaveAttribute("aria-valuenow", "50");
	const initialHeight = (await chat.boundingBox())!.height;
	const box = (await handle.boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 80, {
		steps: 8,
	});
	await page.mouse.up();
	expect((await chat.boundingBox())!.height).toBeCloseTo(initialHeight + 80, 0);
	await handle.focus();
	await page.keyboard.press("Home");
	await page.keyboard.press("ArrowUp");
	await expect(handle).toHaveAttribute("aria-valuenow", "25");
	await page.keyboard.press("Enter");
	await page.keyboard.press("Shift+ArrowDown");
	await expect(handle).toHaveAttribute("aria-valuenow", "60");
	await expect(
		page.getByRole("textbox", { name: "メッセージ", exact: true }),
	).toBeInViewport();
	const geometry = await page
		.locator(".workspace-layout")
		.evaluate((workspace) => ({
			bottom: workspace.getBoundingClientRect().bottom,
			height: innerHeight,
			overflow: document.documentElement.scrollWidth > innerWidth,
		}));
	expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
	expect(geometry.overflow).toBe(false);
	await page.screenshot({
		path: resolve(
			"spec/verification/openui-artifact/resizable-workspace-mobile.png",
		),
	});
	await page.setViewportSize({ width: 1280, height: 900 });
	await expect(handle).toHaveAttribute("aria-valuenow", "60");
	await page.keyboard.press("Enter");
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(handle).toHaveAttribute("aria-valuenow", "60");
});
test("touch resize ends cleanly after release or cancellation", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const handle = page.getByRole("separator", {
		name: "会話とアーティファクトのサイズを調整",
	});
	const workspace = page.locator(".workspace-layout");
	const chat = page.getByRole("region", { name: "会話", exact: true });
	const session = await page.context().newCDPSession(page);
	await session.send("Emulation.setTouchEmulationEnabled", { enabled: true });
	const initialHeight = (await chat.boundingBox())!.height;
	const box = (await handle.boundingBox())!;
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	await session.send("Input.dispatchTouchEvent", {
		type: "touchStart",
		touchPoints: [{ x, y }],
	});
	await expect(workspace).toHaveAttribute("data-resizing", "true");
	await session.send("Input.dispatchTouchEvent", {
		type: "touchMove",
		touchPoints: [{ x, y: y + 40 }],
	});
	await session.send("Input.dispatchTouchEvent", {
		type: "touchEnd",
		touchPoints: [],
	});
	await expect(workspace).not.toHaveAttribute("data-resizing", "true");
	expect((await chat.boundingBox())!.height).toBeCloseTo(initialHeight + 40, 0);
	const next = (await handle.boundingBox())!;
	await session.send("Input.dispatchTouchEvent", {
		type: "touchStart",
		touchPoints: [{ x, y: next.y + next.height / 2 }],
	});
	await expect(workspace).toHaveAttribute("data-resizing", "true");
	await session.send("Input.dispatchTouchEvent", {
		type: "touchCancel",
		touchPoints: [],
	});
	await expect(workspace).not.toHaveAttribute("data-resizing", "true");
	await page.getByLabel("入力の見本").fill("取消後も操作できます");
	await expect(page.getByLabel("入力の見本")).toHaveValue(
		"取消後も操作できます",
	);
	await session.detach();
});

test("all six registered views render through OpenUI; compact JSON and Lang validation", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	const showcase = page.getByRole("region", {
		name: "UIショーケース",
		exact: true,
	});
	for (const [sample, title] of [
		["基本コンポーネント", "入力と操作の見本"],
		["画像の額縁", "生成した画像"],
		["質問と回答", "少し教えてください"],
		["小さなフォーム", "希望を入力"],
		["メモリーの整理", "覚えている情報を確認"],
		["表示と音声の設定", "表示と音声"],
	]) {
		await showcase.getByRole("tab", { name: sample, exact: true }).click();
		await expect(showcase.locator(".aui-preview")).toContainText(title!);
	}
	await showcase
		.getByLabel("UIの定義", { exact: true })
		.fill(
			'{"view":"question","title":"追加の質問","question":{"prompt":"週末は？","options":["自宅","外出"]}}',
		);
	await showcase
		.getByRole("button", { name: "定義を表示", exact: true })
		.click();
	await expect(showcase.locator(".aui-preview")).toContainText("週末は？");
	await showcase.getByRole("radio", { name: "自宅", exact: true }).check();
	await showcase.getByRole("button", { name: "回答する", exact: true }).click();
	await expect(showcase.locator(".aui-preview")).toContainText(
		"回答済み: 自宅",
	);
	await showcase.getByLabel("定義の形式", { exact: true }).selectOption("lang");
	await showcase
		.getByRole("button", { name: "定義を表示", exact: true })
		.click();
	await expect(showcase.getByRole("alert")).toHaveCount(0);
	await showcase
		.getByLabel("UIの定義", { exact: true })
		.fill('root = Query("secret", {})');
	await showcase
		.getByRole("button", { name: "定義を表示", exact: true })
		.click();
	await expect(showcase.getByRole("alert")).toBeVisible();
	await expect(showcase.locator(".aui-preview")).toContainText("週末は？");
	expect(errors).toEqual([]);
});
test("image placeholder, asynchronous completion, fullscreen, download, failure and cancellation", async ({
	page,
}) => {
	const s = page.getByRole("region", { name: "UIショーケース", exact: true });
	await s.getByRole("tab", { name: "画像の額縁", exact: true }).click();
	await expect(s.getByLabel("画像のプレースホルダー")).toBeVisible();
	await s.getByLabel("画像の完成まで", { exact: true }).selectOption("60000");
	await s
		.getByRole("button", { name: "サンプル生成を開始", exact: true })
		.click();
	await expect(s.locator(".aui-preview output")).toContainText(
		"画像を生成中です",
	);
	await s.getByRole("button", { name: "生成を取消", exact: true }).click();
	await expect(s.locator(".aui-preview output")).toContainText(
		"取り消しました",
	);
	await s.getByLabel("画像の完成まで", { exact: true }).selectOption("500");
	await s
		.getByRole("button", { name: "サンプル生成を開始", exact: true })
		.click();
	await expect(
		s.getByRole("img", { name: "山と湖のイラスト", exact: true }),
	).toBeVisible();
	await s
		.getByRole("button", { name: "画像を全画面で表示", exact: true })
		.click();
	const dialog = page.getByRole("dialog", { name: "生成画像の全画面表示" });
	await expect(dialog).toBeVisible();
	const box = await dialog.boundingBox();
	expect(box!.width).toBeGreaterThan(page.viewportSize()!.width * 0.9);
	await expect(
		dialog.getByRole("button", { name: "Close", exact: true }),
	).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	const download = page.waitForEvent("download");
	await s
		.getByRole("link", { name: "画像をダウンロード", exact: true })
		.click();
	const file = await download;
	expect(file.suggestedFilename()).toBe("generated-image.svg");
	expect(await file.failure()).toBeNull();
	await s.getByRole("button", { name: "画像読込失敗", exact: true }).click();
	await expect(s.locator(".aui-preview output")).toContainText(
		"画像を読み込めませんでした",
	);
	await expect(
		s.getByRole("link", { name: "画像をダウンロード", exact: true }),
	).toHaveCount(0);
	await s.getByRole("button", { name: "画像を完成", exact: true }).click();
	await expect(
		s.getByRole("img", { name: "山と湖のイラスト", exact: true }),
	).toBeVisible();
	await s.getByRole("button", { name: "生成失敗", exact: true }).click();
	await expect(s.locator(".aui-preview output")).toContainText(
		"画像生成に失敗しました",
	);
});
test("radio answers have full-row targets, native keyboard selection and retain submitted answers", async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	const s = page.getByRole("region", { name: "UIショーケース", exact: true });
	await s.getByRole("tab", { name: "質問と回答", exact: true }).click();
	const rows = s.locator(".ds-radio-option");
	const radios = s.getByRole("radio");
	await expect(radios).toHaveCount(2);
	const box = (await rows.first().boundingBox())!;
	expect(box.height).toBeGreaterThanOrEqual(44);
	await rows
		.first()
		.click({ position: { x: box.width - 12, y: box.height / 2 } });
	await expect(radios.first()).toBeChecked();
	await expect(s.locator(".aui-preview")).not.toContainText("回答済み");
	await radios.first().focus();
	await page.keyboard.press("ArrowDown");
	await expect(radios.nth(1)).toBeChecked();
	await expect(radios.nth(1)).toBeFocused();
	const selected = await rows
		.nth(1)
		.evaluate((row) => getComputedStyle(row).backgroundColor);
	expect(
		await rows.first().evaluate((row) => getComputedStyle(row).backgroundColor),
	).not.toBe(selected);
	await rows.nth(1).hover();
	expect(
		await rows.nth(1).evaluate((row) => getComputedStyle(row).backgroundColor),
	).toBe(selected);
	const answer = await radios.nth(1).inputValue();
	await s.getByRole("button", { name: "回答する", exact: true }).click();
	await expect(s.locator(".aui-preview")).toContainText(`回答済み: ${answer}`);
	await expect(radios.nth(1)).toBeDisabled();
	await s.getByRole("tab", { name: "基本コンポーネント", exact: true }).click();
	await s.getByRole("tab", { name: "質問と回答", exact: true }).click();
	await expect(radios.nth(1)).toBeChecked();
	await expect(radios.nth(1)).toBeDisabled();
	await s
		.getByRole("button", { name: "このサンプルを初期化", exact: true })
		.click();
	await expect(radios.first()).not.toBeChecked();
	await expect(radios.nth(1)).not.toBeChecked();
	await s.getByLabel("UIの定義", { exact: true }).fill(
		JSON.stringify({
			view: "question",
			title: "回答の長さ",
			question: {
				prompt: "どのくらい詳しく説明しますか？",
				options: [
					"要点を短くまとめてほしい",
					"背景や理由、具体例も含めて、初めて読む人にも分かるように詳しく説明してほしい",
				],
			},
		}),
	);
	await s.getByRole("button", { name: "定義を表示", exact: true }).click();
	await radios.nth(1).check();
	await s.getByText("開発用の確認", { exact: true }).click();
	const screenshotDir = resolve("spec/verification/openui-artifact");
	for (const theme of ["dark", "light"]) {
		await s.getByLabel("プレビューのテーマ").selectOption(theme);
		await s.locator(".aui-preview").screenshot({
			path: join(screenshotDir, `question-radio-${theme}.png`),
			animations: "disabled",
		});
	}
	await page.setViewportSize({ width: 390, height: 844 });
	await s.getByLabel("プレビューのテーマ").selectOption("dark");
	await s.getByLabel("プレビューの幅").selectOption("narrow");
	const preview = s.locator(".aui-preview");
	expect(await preview.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
		true,
	);
	await expect(radios.nth(1)).toHaveAccessibleName(
		"背景や理由、具体例も含めて、初めて読む人にも分かるように詳しく説明してほしい",
	);
	await preview.screenshot({
		path: join(screenshotDir, "question-radio-narrow.png"),
		animations: "disabled",
	});
});

test("question and form validation, retry, reset, input retention and duplicate submit protection", async ({
	page,
}) => {
	const s = page.getByRole("region", { name: "UIショーケース", exact: true });
	await s.getByRole("tab", { name: "質問と回答", exact: true }).click();
	await expect(
		s.getByRole("button", { name: "回答する", exact: true }),
	).toBeDisabled();
	await s.getByRole("radio", { name: "短く", exact: true }).check();
	await s.getByRole("button", { name: "回答する", exact: true }).click();
	await expect(s.locator(".aui-preview")).toContainText("回答済み: 短く");
	await expect(
		s.getByRole("button", { name: "回答する", exact: true }),
	).toBeDisabled();
	await s.getByRole("button", { name: "自由回答に変更", exact: true }).click();
	await s.getByLabel("回答", { exact: true }).fill("のぐち");
	await s
		.getByRole("button", { name: "質問を期限切れにする", exact: true })
		.click();
	await expect(
		s.getByRole("button", { name: "回答する", exact: true }),
	).toBeDisabled();
	await expect(s.locator(".aui-preview")).toContainText("期限切れ");
	await s.getByRole("tab", { name: "小さなフォーム", exact: true }).click();
	const submit = s.getByRole("button", { name: "フォームを送信", exact: true });
	await submit.click();
	expect(
		await s
			.getByLabel("呼び名（必須）")
			.evaluate((input: HTMLInputElement) => input.validity.valueMissing),
	).toBe(true);
	await expect(s.getByLabel("操作イベント").locator("li")).toHaveCount(0);
	await s.getByLabel("呼び名（必須）").fill("入力途中");
	await s
		.getByRole("button", { name: "参照データを更新", exact: true })
		.click();
	await expect(s.getByLabel("呼び名（必須）")).toHaveValue("入力途中");
	await s
		.getByRole("button", { name: "次の送信を失敗させる", exact: true })
		.click();
	await submit.click();
	await expect(s.locator(".aui-preview")).toContainText("再試行できます");
	await expect(s.getByLabel("呼び名（必須）")).toHaveValue("入力途中");
	await submit.evaluate((button: HTMLButtonElement) => {
		button.click();
		button.click();
	});
	await expect(s.locator(".aui-preview")).toContainText("操作を受け付けました");
	await expect(
		s
			.getByLabel("操作イベント")
			.locator('li[data-status="accepted"]', { hasText: "フォームの送信" }),
	).toHaveCount(1);
	await s.getByRole("button", { name: "入力をリセット", exact: true }).click();
	await expect(s.getByLabel("呼び名（必須）")).toHaveValue("");
});
test("settings theme shares the width and density toolbar and matches the visible preview", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1280, height: 1100 });
	await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	const s = page.getByRole("region", { name: "UIショーケース", exact: true });
	await s
		.getByLabel("プレビューのテーマ", { exact: true })
		.selectOption("dark");
	await s.getByRole("tab", { name: "表示と音声の設定", exact: true }).click();
	const theme = s.getByLabel("プレビューのテーマ", { exact: true });
	const card = s.locator(".aui-settings-theme");
	const saved = s.getByRole("region", {
		name: "試用データの現在値",
		exact: true,
	});
	const brightness = () =>
		card.evaluate((el) => {
			const channels = getComputedStyle(el)
				.backgroundColor.match(/[\d.]+/g)!
				.slice(0, 3)
				.map(Number);
			return channels.reduce((sum, channel) => sum + channel, 0) / 3;
		});
	await expect(theme).toHaveValue("dark");
	await expect.poll(brightness).toBeLessThan(60);
	await expect(s.getByLabel("表示テーマ", { exact: true })).toHaveCount(0);
	const controls = s.locator(".aui-controls");
	await expect(controls.getByRole("combobox")).toHaveCount(5);
	const boxes = await Promise.all([
		theme.boundingBox(),
		s.getByLabel("プレビューの幅", { exact: true }).boundingBox(),
		s.getByLabel("表示の密度", { exact: true }).boundingBox(),
	]);
	for (const box of boxes) expect(box!.y).toBeCloseTo(boxes[0]!.y, 0);
	await theme.selectOption("light");
	await expect.poll(brightness).toBeGreaterThan(200);
	await expect(card).toHaveCSS("color-scheme", "light");
	await theme.selectOption("dark");
	await expect.poll(brightness).toBeLessThan(60);
	await expect(card).toHaveCSS("color-scheme", "dark");
	await expect(saved).toContainText("ライト");
	await s
		.getByRole("button", { name: "次の送信を失敗させる", exact: true })
		.click();
	await s.getByRole("button", { name: "設定を保存", exact: true }).click();
	await expect(card).toContainText("再試行できます");
	await expect(theme).toHaveValue("dark");
	await expect(saved).toContainText("ライト");
	await s.getByRole("button", { name: "設定を保存", exact: true }).click();
	await expect(saved).toContainText("ダーク");
	await s.getByRole("tab", { name: "質問と回答", exact: true }).click();
	await s.getByRole("tab", { name: "表示と音声の設定", exact: true }).click();
	await expect(theme).toHaveValue("dark");
	await expect.poll(brightness).toBeLessThan(60);
	await s.getByText("開発用の確認", { exact: true }).click();
	await s.screenshot({
		path: resolve(
			"spec/verification/openui-artifact/settings-controls-dark.png",
		),
		animations: "disabled",
	});
	await s
		.getByRole("button", { name: "このサンプルを初期化", exact: true })
		.click();
	await expect(theme).toHaveValue("dark");
	await expect.poll(brightness).toBeLessThan(60);
	await expect(saved).toContainText("ライト");
	await theme.selectOption("light");
	await expect.poll(brightness).toBeGreaterThan(200);
	await s.screenshot({
		path: resolve(
			"spec/verification/openui-artifact/settings-controls-light.png",
		),
		animations: "disabled",
	});
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	await page.setViewportSize({ width: 390, height: 844 });
	const mobileBoxes = await Promise.all([
		theme.boundingBox(),
		s.getByLabel("プレビューの幅", { exact: true }).boundingBox(),
		s.getByLabel("表示の密度", { exact: true }).boundingBox(),
	]);
	for (const box of mobileBoxes)
		expect(box!.y).toBeCloseTo(mobileBoxes[0]!.y, 0);
	await controls.screenshot({
		path: resolve(
			"spec/verification/openui-artifact/settings-controls-mobile.png",
		),
		animations: "disabled",
	});
});

test("memory correction and settings save affect only fixture state; theme, responsive layout and screenshots", async ({
	page,
}) => {
	const s = page.getByRole("region", { name: "UIショーケース", exact: true });
	await s.getByRole("tab", { name: "メモリーの整理", exact: true }).click();
	await s
		.getByLabel("メモリーの内容", { exact: true })
		.fill("図を添えて説明してほしい");
	await s.getByRole("button", { name: "訂正を反映", exact: true }).click();
	await expect(s.locator(".aui-preview")).toContainText("操作を受け付けました");
	await s.getByRole("checkbox", { name: /利用候補に選ぶ:/ }).check();
	await expect(
		s.getByRole("checkbox", { name: /利用候補に選ぶ:/ }),
	).toBeChecked();
	await s.getByRole("tab", { name: "表示と音声の設定", exact: true }).click();
	await s
		.getByLabel("プレビューのテーマ", { exact: true })
		.selectOption("dark");
	await s
		.getByRole("switch", { name: "回答を読み上げる", exact: true })
		.check();
	await s.getByRole("button", { name: "設定を保存", exact: true }).click();
	await expect(s.locator(".aui-preview")).toContainText("操作を受け付けました");
	await expect(s.getByLabel("操作イベント")).toContainText("試用設定の保存");
	await s.getByRole("tab", { name: "画像の額縁", exact: true }).click();
	await s.getByRole("button", { name: "画像を完成", exact: true }).click();
	await s
		.getByLabel("プレビューのテーマ", { exact: true })
		.selectOption("dark");
	await s.getByLabel("表示の密度", { exact: true }).selectOption("compact");
	await expect(s.locator(".aui-preview")).toHaveAttribute("data-theme", "dark");
	await page.setViewportSize({ width: 1280, height: 1000 });
	const screenshotDir = resolve("spec/verification/openui-artifact");
	mkdirSync(screenshotDir, { recursive: true });
	await page
		.locator(".artifact-panel-body")
		.evaluate((element) => (element.scrollTop = 0));
	await page.screenshot({ path: join(screenshotDir, "showcase-desktop.png") });
	await s.getByLabel("プレビューの幅", { exact: true }).selectOption("narrow");
	expect(
		(await s.locator(".aui-preview").boundingBox())!.width,
	).toBeLessThanOrEqual(320);
	await page
		.locator(".artifact-panel-body")
		.evaluate((element) => (element.scrollTop = 0));
	await page.screenshot({ path: join(screenshotDir, "showcase-narrow.png") });
	await page.setViewportSize({ width: 390, height: 844 });
	await page
		.locator(".artifact-panel")
		.evaluate((element) => element.scrollIntoView({ block: "start" }));
	await page
		.locator(".artifact-panel-body")
		.evaluate((element) => (element.scrollTop = 0));
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);
	await page.screenshot({ path: join(screenshotDir, "showcase-mobile.png") });
	await page
		.getByRole("button", { name: "UIショーケースを閉じる", exact: true })
		.click();
	await expect(s).toHaveCount(0);
});

test("tabs use keyboard navigation; only the body has p-2 and closing the last tab removes the pane", async ({
	page,
}) => {
	const s = page.getByRole("region", { name: "UIショーケース", exact: true });
	const sampleTabs = s.getByRole("tablist", { name: "表示サンプル" });
	await sampleTabs
		.getByRole("tab", { name: "基本コンポーネント", exact: true })
		.focus();
	await page.keyboard.press("ArrowRight");
	await expect(
		sampleTabs.getByRole("tab", { name: "画像の額縁", exact: true }),
	).toHaveAttribute("aria-selected", "true");
	await expect(s.locator(".aui-preview")).toContainText("生成した画像");
	for (const width of [1280, 790, 390]) {
		await page.setViewportSize({ width, height: 900 });
		const geometry = await page.locator(".artifact-panel").evaluate((panel) => {
			const header = panel.querySelector(".artifact-panel-header")!;
			const body = panel.querySelector(".artifact-panel-body:not([hidden])")!;
			const p = getComputedStyle(panel),
				h = getComputedStyle(header),
				b = getComputedStyle(body);
			return {
				panelPadding: p.padding,
				headerPadding: h.padding,
				bodyPadding: b.padding,
				gap:
					body.getBoundingClientRect().top -
					header.getBoundingClientRect().bottom,
				overflow: document.documentElement.scrollWidth > innerWidth,
			};
		});
		expect(geometry).toEqual({
			panelPadding: "0px",
			headerPadding: "0px",
			bodyPadding: "8px",
			gap: 0,
			overflow: false,
		});
	}
	await page.setViewportSize({ width: 1280, height: 900 });
	await page
		.getByRole("button", { name: "UIショーケースを閉じる", exact: true })
		.click();
	await expect(page.locator(".artifact-panel")).toHaveCount(0);
});

test("sample operations show concrete results and only relevant test controls", async ({
	page,
}) => {
	const s = page.getByRole("region", { name: "UIショーケース", exact: true });
	await s.getByText("開発用の確認", { exact: true }).click();
	await expect(
		s.getByRole("button", { name: "画像を完成", exact: true }),
	).toHaveCount(0);
	await s.getByLabel("入力の見本").fill("操作した内容");
	await s.getByRole("button", { name: "試す", exact: true }).click();
	await expect(
		s.getByRole("region", { name: "受け取った内容", exact: true }),
	).toContainText("操作した内容");
	await s.getByText("開発用の確認", { exact: true }).click();
	await expect(s.getByLabel("操作イベント")).toContainText("入力の確認");
	await expect(s.getByLabel("操作イベント")).toContainText("完了");
	await expect(s.getByLabel("操作イベント")).not.toContainText("accepted");
	await expect(
		s.getByRole("button", { name: "質問を期限切れにする", exact: true }),
	).toHaveCount(0);
	await s.getByRole("tab", { name: "小さなフォーム", exact: true }).click();
	await expect(s.getByLabel("操作イベント")).toBeEmpty();
	await s.getByLabel("呼び名（必須）").fill("のぐち");
	await s.getByRole("button", { name: "フォームを送信", exact: true }).click();
	await expect(
		s.getByRole("region", { name: "前回受け取った内容", exact: true }),
	).toContainText("のぐち");
	await s.getByRole("tab", { name: "メモリーの整理", exact: true }).click();
	await s
		.getByLabel("メモリーの内容", { exact: true })
		.fill("図で説明してほしい");
	await s.getByRole("button", { name: "訂正を反映", exact: true }).click();
	await expect(
		s.getByRole("region", { name: "試用データの現在値", exact: true }),
	).toContainText("図で説明してほしい");
	await s.getByRole("checkbox", { name: /利用候補に選ぶ:/ }).check();
	await expect(
		s.getByRole("region", { name: "試用データの現在値", exact: true }),
	).toContainText("選択済み");
	await s.getByRole("tab", { name: "表示と音声の設定", exact: true }).click();
	const productTheme = await page.locator("html").getAttribute("data-theme");
	await s
		.getByLabel("プレビューのテーマ", { exact: true })
		.selectOption("dark");
	await s
		.getByRole("switch", { name: "回答を読み上げる", exact: true })
		.check();
	await s.getByRole("button", { name: "設定を保存", exact: true }).click();
	await expect(
		s.getByRole("region", { name: "試用データの現在値", exact: true }),
	).toContainText("ダーク");
	await expect(
		s.getByRole("region", { name: "試用データの現在値", exact: true }),
	).toContainText("オン");
	expect(await page.locator("html").getAttribute("data-theme")).toBe(
		productTheme,
	);
	await s
		.getByRole("button", { name: "このサンプルを初期化", exact: true })
		.click();
	await expect(
		s.getByRole("region", { name: "試用データの現在値", exact: true }),
	).toContainText("ライト");
	await s.getByRole("tab", { name: "小さなフォーム", exact: true }).click();
	await expect(
		s.getByRole("region", { name: "前回受け取った内容", exact: true }),
	).toContainText("のぐち");
});

test("tabs fit the pane without horizontal scrolling and clearly distinguish selection, including zoom", async ({
	page,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	const s = page.getByRole("region", { name: "UIショーケース", exact: true });
	await s.getByText("開発用の確認", { exact: true }).click();
	await s
		.getByLabel("プレビューのテーマ", { exact: true })
		.selectOption("dark");
	const tabs = s.getByRole("tablist", { name: "表示サンプル" });
	for (const width of [1840, 1280, 790, 390, 320]) {
		await page.setViewportSize({ width, height: 1000 });
		for (const zoom of [1, 2]) {
			await page.locator("body").evaluate((body, zoom) => {
				body.style.zoom = String(zoom);
			}, zoom);
			const measurements = await tabs.evaluate((list) => {
				const active = list.querySelector('[aria-selected="true"]')!;
				const inactive = list.querySelector('[aria-selected="false"]')!;
				const a = getComputedStyle(active),
					b = getComputedStyle(inactive);
				return {
					scrollWidth: list.scrollWidth,
					clientWidth: list.clientWidth,
					scrollLeft: list.scrollLeft,
					overflow: getComputedStyle(list).overflowX,
					selectedBackground: a.backgroundColor,
					otherBackground: b.backgroundColor,
					selectedWeight: a.fontWeight,
					otherWeight: b.fontWeight,
					labelsUseEllipsis: [...list.querySelectorAll(".ds-tabs-label")].every(
						(label) => getComputedStyle(label).textOverflow === "ellipsis",
					),
				};
			});
			expect(measurements.scrollWidth).toBeLessThanOrEqual(
				measurements.clientWidth,
			);
			expect(measurements.scrollLeft).toBe(0);
			expect(measurements.overflow).toBe("hidden");
			expect(measurements.selectedBackground).not.toBe(
				measurements.otherBackground,
			);
			expect(Number(measurements.selectedWeight)).toBeGreaterThan(
				Number(measurements.otherWeight),
			);
			expect(measurements.labelsUseEllipsis).toBe(true);
			await tabs
				.getByRole("tab", { name: "表示と音声の設定", exact: true })
				.click();
			await expect(
				tabs.getByRole("tab", { name: "表示と音声の設定", exact: true }),
			).toHaveAttribute("aria-selected", "true");
			await tabs
				.getByRole("tab", { name: "基本コンポーネント", exact: true })
				.click();
		}
	}
	await page.locator("body").evaluate((body) => {
		body.style.zoom = "1";
	});
	await s.getByLabel("入力の見本").fill("入力した内容を確認できます");
	await s.getByRole("button", { name: "試す", exact: true }).click();
	await expect(
		s.getByRole("region", { name: "受け取った内容", exact: true }),
	).toContainText("入力した内容を確認できます");
	const screenshotDir = resolve("spec/verification/openui-artifact");
	for (const [width, name] of [
		[1840, "desktop"],
		[390, "mobile"],
	] as const) {
		await page.setViewportSize({ width, height: 1000 });
		await page.locator(".artifact-panel").scrollIntoViewIfNeeded();
		await page.locator(".artifact-panel").screenshot({
			path: join(screenshotDir, `interaction-review-${name}.png`),
		});
	}
});

test("all design presets affect the sample and settings while the host and sample tabs stay unchanged", async ({
	page,
}) => {
	const s = page.getByRole("region", { name: "UIショーケース", exact: true });
	const preview = s.locator(".aui-preview");
	const hostBefore = await page.locator("html").evaluate((el) => ({
		theme: el.getAttribute("data-theme"),
		density: el.getAttribute("data-density"),
		radius: getComputedStyle(el).getPropertyValue("--radius"),
	}));
	const tabsBefore = await s.locator(".aui-sample-tabs").evaluate((el) => ({
		height: el.getBoundingClientRect().height,
		radius: getComputedStyle(el).borderRadius,
	}));
	const theme = s.getByLabel("プレビューのテーマ", { exact: true });
	await expect(theme.locator("option")).toHaveCount(11);
	await s.getByRole("tab", { name: "表示と音声の設定", exact: true }).click();
	for (const name of await theme
		.locator("option")
		.evaluateAll((options) =>
			options.map((option) => (option as HTMLOptionElement).value),
		)) {
		await theme.selectOption(name);
		await expect(preview).toHaveAttribute("data-theme", name);
		const colors = await preview.evaluate((el) => {
			const reference = document.createElement("div");
			reference.style.backgroundColor =
				getComputedStyle(el).getPropertyValue("--card");
			el.append(reference);
			const expected = getComputedStyle(reference).backgroundColor;
			reference.remove();
			return {
				expected,
				actual: getComputedStyle(el.querySelector(".aui-settings-theme")!)
					.backgroundColor,
			};
		});
		expect(colors.actual, name).toBe(colors.expected);
	}
	await s.getByRole("tab", { name: "基本コンポーネント", exact: true }).click();
	const input = s.getByLabel("入力の見本", { exact: true });
	await s.getByLabel("角の丸み", { exact: true }).selectOption("0rem");
	await expect(input).toHaveCSS("border-radius", "0px");
	await s.getByLabel("角の丸み", { exact: true }).selectOption("1rem");
	await expect(input).toHaveCSS("border-radius", "14px");
	await s.getByLabel("表示の密度", { exact: true }).selectOption("spacious");
	await expect(input).toHaveCSS("font-size", "16px");
	await s.getByLabel("タッチ操作", { exact: true }).selectOption("true");
	await expect(input).toHaveCSS("font-size", "18px");
	await expect
		.poll(() =>
			preview.evaluate((el) =>
				getComputedStyle(el).getPropertyValue("--ui-touch-target-min"),
			),
		)
		.toBe("44px");
	await s
		.getByRole("button", { name: "このサンプルを初期化", exact: true })
		.click();
	await expect(s.getByLabel("角の丸み", { exact: true })).toHaveValue("1rem");
	await expect(s.getByLabel("表示の密度", { exact: true })).toHaveValue(
		"spacious",
	);
	await expect(s.getByLabel("タッチ操作", { exact: true })).toHaveValue("true");
	expect(
		await page.locator("html").evaluate((el) => ({
			theme: el.getAttribute("data-theme"),
			density: el.getAttribute("data-density"),
			radius: getComputedStyle(el).getPropertyValue("--radius"),
		})),
	).toEqual(hostBefore);
	expect(
		await s.locator(".aui-sample-tabs").evaluate((el) => ({
			height: el.getBoundingClientRect().height,
			radius: getComputedStyle(el).borderRadius,
		})),
	).toEqual(tabsBefore);
});

test("every design token can be edited, invalid input preserves the preview, and reset restores all values", async ({
	page,
}) => {
	const s = page.getByRole("region", { name: "UIショーケース", exact: true });
	const preview = s.locator(".aui-preview");
	const hostBefore = await page.locator("html").evaluate((el) => ({
		style: el.getAttribute("style"),
		theme: el.getAttribute("data-theme"),
	}));
	const defaultTokens = await preview.evaluate((el) =>
		Object.fromEntries(
			Array.from((el as HTMLElement).style)
				.filter(
					(name) =>
						name.startsWith("--") &&
						!name.startsWith("--color-") &&
						!name.startsWith("--spacing-") &&
						!/^--radius-(lg|md|sm)$/.test(name),
				)
				.map((name) => [
					name,
					(el as HTMLElement).style.getPropertyValue(name),
				]),
		),
	);
	await s.locator(".aui-token-editor > summary").click();
	await s.getByLabel("トークンの種類", { exact: true }).selectOption("すべて");
	const tokens = await s.locator(".aui-token-field").evaluateAll((fields) =>
		fields.map((field) => ({
			name: field.getAttribute("data-token")!,
			color: !!field.querySelector(".aui-token-color"),
		})),
	);
	expect(tokens.length).toBeGreaterThan(60);
	for (const token of tokens) {
		const value = token.color ? "#168a6e" : "12px";
		await s.getByLabel(`トークン ${token.name}`, { exact: true }).fill(value);
		await expect
			.poll(() =>
				preview.evaluate(
					(el, name) => getComputedStyle(el).getPropertyValue(name).trim(),
					token.name,
				),
			)
			.toBe(value);
	}
	await s
		.getByLabel("トークン --primary-foreground", { exact: true })
		.fill("#fafafa");
	await expect(s.getByRole("button", { name: "試す", exact: true })).toHaveCSS(
		"color",
		"rgb(250, 250, 250)",
	);
	await expect(s.getByLabel("入力の見本", { exact: true })).toHaveCSS(
		"font-size",
		"12px",
	);
	await expect(s.getByLabel("入力の見本", { exact: true })).toHaveCSS(
		"padding-left",
		"12px",
	);
	await s.getByLabel("トークン --radius", { exact: true }).fill("-3px");
	await expect(
		s.getByLabel("トークン --radius", { exact: true }),
	).toHaveAttribute("aria-invalid", "true");
	await expect(s.getByLabel("入力の見本", { exact: true })).toHaveCSS(
		"border-radius",
		"10px",
	);
	await s
		.getByLabel("トークン --primary", { exact: true })
		.fill("broken-color");
	await expect(
		s.getByLabel("トークン --primary", { exact: true }),
	).toHaveAttribute("aria-invalid", "true");
	await s
		.getByRole("button", { name: "--radius を元に戻す", exact: true })
		.click();
	await expect(s.getByLabel("角の丸み", { exact: true })).toHaveValue("0.5rem");
	await s.getByRole("tab", { name: "表示と音声の設定", exact: true }).click();
	await expect(s.locator(".aui-settings-theme")).toHaveCSS(
		"background-color",
		"rgb(22, 138, 110)",
	);
	await s
		.getByRole("button", { name: "デザイントークンを初期化", exact: true })
		.click();
	expect(
		await preview.evaluate((el) =>
			Object.fromEntries(
				Array.from((el as HTMLElement).style)
					.filter(
						(name) =>
							name.startsWith("--") &&
							!name.startsWith("--color-") &&
							!name.startsWith("--spacing-") &&
							!/^--radius-(lg|md|sm)$/.test(name),
					)
					.map((name) => [
						name,
						(el as HTMLElement).style.getPropertyValue(name),
					]),
			),
		),
	).toEqual(defaultTokens);
	expect(
		await page.locator("html").evaluate((el) => ({
			style: el.getAttribute("style"),
			theme: el.getAttribute("data-theme"),
		})),
	).toEqual(hostBefore);
});

test("design token controls and long token names fit a mobile panel without horizontal scrolling", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const s = page.getByRole("region", { name: "UIショーケース", exact: true });
	await s.getByRole("tab", { name: "基本コンポーネント", exact: true }).click();
	await s.locator(".aui-token-editor > summary").click();
	await s
		.getByLabel("トークンを検索", { exact: true })
		.fill("sidebar-primary-foreground");
	await expect(s.locator(".aui-token-field")).toHaveCount(1);
	await s
		.getByLabel("トークン --sidebar-primary-foreground", { exact: true })
		.fill("#eeeeee");
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);
	for (const selector of [
		".aui-controls",
		".aui-token-editor",
		".aui-sample-tabs",
	])
		expect(
			await s
				.locator(selector)
				.evaluate((el) => el.scrollWidth <= el.clientWidth),
		).toBe(true);
	await s.getByText("開発用の確認", { exact: true }).click();
	await page.locator(".artifact-panel-body").evaluate((el) => {
		el.scrollTop = 0;
	});
	await page.locator(".artifact-panel").screenshot({
		path: resolve("spec/verification/openui-artifact/design-tokens-mobile.png"),
		animations: "disabled",
	});
	await page.setViewportSize({ width: 1280, height: 1100 });
	await s.getByLabel("トークンを検索", { exact: true }).fill("");
	await s.getByLabel("角の丸み", { exact: true }).selectOption("1rem");
	await page.locator(".artifact-panel-body").evaluate((el) => {
		el.scrollTop = 0;
	});
	await page.locator(".artifact-panel").screenshot({
		path: resolve(
			"spec/verification/openui-artifact/design-tokens-desktop.png",
		),
		animations: "disabled",
	});
});
