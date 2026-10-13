import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture } from "./fixture";
import { openFromLauncher } from "./artifact-launcher";
import { createClient } from "../../client";

const fixture = createFixture();
let dir: string;
let apiPort: number;
let webPort: number;
const token = "settings-artifact-fixture-token";
// A cold Vite build and the complete new/legacy/reload flow share this budget.
test.setTimeout(60_000);
test.beforeAll(async () => {
	[apiPort, webPort] = (await fixture.ports(2)) as [number, number];
	dir = mkdtempSync(join(tmpdir(), "eumenes-settings-artifacts-"));
	await fixture.launch(
		["api/application/server.ts"],
		{
			EUMENES_DB: join(dir, "fixture.sqlite3"),
			EUMENES_TOOLCHAIN_ENABLED: "0",
			EUMENES_LOG_FILE: join(dir, "api.jsonl"),
			EUMENES_API_TOKEN: token,
			EUMENES_SECRET_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
			EUMENES_PORT: String(apiPort),
			EUMENES_ORIGIN: "http://127.0.0.1:" + webPort,
		},
		{ ports: [apiPort] },
	);
	await fixture.ready("http://127.0.0.1:" + apiPort + "/api/status");
	await fixture.launchWeb({
		apiPort,
		webPort,
		token,
		cacheDir: join(dir, "vite-cache"),
	});
	await fixture.ready("http://127.0.0.1:" + webPort);
});
test.afterAll(async () => {
	await fixture.stopAll();
	if (dir) rmSync(dir, { recursive: true, force: true });
});

test("settings entry, OpenUI edits, tab lifecycle and real settings API persist together", async ({
	page,
}) => {
	const client = createClient("http://127.0.0.1:" + apiPort, token);
	await page.goto("http://127.0.0.1:" + webPort);
	await openFromLauncher(page, "設定");
	const artifact = page.getByRole("complementary", {
		name: "アーティファクト",
	});
	await expect(artifact.getByLabel("設定項目を探す")).toBeVisible();
	await expect(
		artifact.getByRole("button", { name: "音声と入力", exact: true }),
	).toBeEnabled();
	await expect(
		artifact.getByRole("button", {
			name: /AIと接続|予約|委任した作業|プロジェクト/,
		}),
	).toHaveCount(0);
	await artifact.getByRole("button", { name: "会話", exact: true }).click();
	await artifact
		.getByLabel("AIの名前", { exact: true })
		.fill("アーティファクト試験");
	await artifact.getByLabel("あなたの名前", { exact: true }).fill("共有試験");
	await artifact.getByLabel("口調", { exact: true }).selectOption("sage");
	await artifact.getByRole("button", { name: "会話の設定を閉じる" }).click();
	await artifact.getByRole("tab", { name: "設定", exact: true }).click();
	await artifact.getByRole("button", { name: "会話", exact: true }).click();
	await expect(artifact.getByLabel("AIの名前", { exact: true })).toHaveValue(
		"アーティファクト試験",
	);
	await page.getByRole("button", { name: "設定", exact: true }).click();
	const legacy = page.locator(".settings-layout");
	await expect(legacy.getByLabel("AIの名前", { exact: true })).toHaveValue(
		"アーティファクト試験",
	);
	await legacy
		.getByLabel("あなたの名前", { exact: true })
		.fill("旧画面からの追加入力");
	await page.getByRole("button", { name: "会話に戻る", exact: true }).click();
	await expect(
		artifact.getByLabel("あなたの名前", { exact: true }),
	).toHaveValue("旧画面からの追加入力");
	await artifact.getByRole("button", { name: "変更一覧を開く" }).click();
	await expect(
		artifact.getByText("会話 / 口調", { exact: true }),
	).toBeVisible();
	await artifact
		.getByRole("button", { name: "設定の変更をすべて適用" })
		.click();
	await expect(
		artifact.getByText("変更を適用しました", { exact: true }),
	).toBeVisible();
	expect((await client.settings()).general).toMatchObject({
		agentName: "アーティファクト試験",
		userName: "旧画面からの追加入力",
		persona: "sage",
	});
	await artifact.screenshot({
		path: "spec/verification/settings-artifacts-2026-10-12/settings-artifact-applied.png",
	});
	await page.reload();
	await openFromLauncher(page, "設定");
	await artifact.getByRole("button", { name: "会話", exact: true }).click();
	await expect(artifact.getByLabel("AIの名前", { exact: true })).toHaveValue(
		"アーティファクト試験",
	);
	await page.screenshot({
		path: "spec/verification/settings-artifacts-2026-10-12/settings-artifact-conversation.png",
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(artifact.getByLabel("口調", { exact: true })).toBeVisible();
	await artifact.getByLabel("あなたの名前", { exact: true }).focus();
	await page.keyboard.press("Tab");
	await expect(artifact.getByLabel("口調", { exact: true })).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(
		artifact.getByRole("button", { name: "変更一覧を開く" }),
	).toBeFocused();
	await artifact.locator(".ds-settings-panel").screenshot({
		path: "spec/verification/settings-artifacts-2026-10-12/settings-artifact-narrow.png",
	});
});

test("conversation has an in-place save button and reload reads the saved settings", async ({
	page,
}) => {
	const client = createClient("http://127.0.0.1:" + apiPort, token);
	await page.goto("http://127.0.0.1:" + webPort);
	await openFromLauncher(page, "設定");
	const artifact = page.getByRole("complementary", {
		name: "アーティファクト",
	});
	await artifact.getByRole("button", { name: "会話", exact: true }).click();
	const save = artifact.getByRole("button", {
		name: "設定の変更をすべて保存",
		exact: true,
	});
	await expect(save).toBeVisible();
	await expect(save).toBeDisabled();
	await artifact.getByLabel("AIの名前", { exact: true }).fill("会話から保存");
	await artifact.getByLabel("あなたの名前", { exact: true }).fill("保存試験");
	await artifact.getByLabel("口調", { exact: true }).selectOption("butler");
	await expect(save).toBeEnabled();
	await save.click();
	await expect(
		artifact.getByText("変更を適用しました", { exact: true }),
	).toBeVisible();
	await expect(artifact.getByLabel("AIの名前", { exact: true })).toHaveValue(
		"会話から保存",
	);
	await expect(save).toBeDisabled();
	expect((await client.settings()).general).toMatchObject({
		agentName: "会話から保存",
		userName: "保存試験",
		persona: "butler",
	});
	await artifact.locator(".ds-settings-panel").screenshot({
		path: "spec/verification/settings-artifacts-2026-10-12/conversation-direct-save.png",
	});
	await page.reload();
	await openFromLauncher(page, "設定");
	await artifact.getByRole("button", { name: "会話", exact: true }).click();
	await expect(artifact.getByLabel("AIの名前", { exact: true })).toHaveValue(
		"会話から保存",
	);
	await expect(
		artifact.getByLabel("あなたの名前", { exact: true }),
	).toHaveValue("保存試験");
	await expect(artifact.getByLabel("口調", { exact: true })).toHaveValue(
		"butler",
	);
	await page.setViewportSize({ width: 390, height: 844 });
	await save.scrollIntoViewIfNeeded();
	await expect(save).toBeVisible();
	await expect(save).toBeInViewport();
	await artifact.screenshot({
		path: "spec/verification/settings-artifacts-2026-10-12/conversation-direct-save-narrow.png",
	});
});

test("voice/input saves directly from speech, input and devices and reloads persisted values", async ({
	page,
}) => {
	const client = createClient("http://127.0.0.1:" + apiPort, token);
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "mediaDevices", {
			value: {
				getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
				enumerateDevices: async () => [
					{
						deviceId: "direct-save-mic",
						kind: "audioinput",
						label: "保存試験マイク",
					},
				],
			},
		});
	});
	await page.goto("http://127.0.0.1:" + webPort);
	await openFromLauncher(page, "設定");
	const artifact = page.getByRole("complementary", {
		name: "アーティファクト",
	});
	await artifact
		.getByRole("button", { name: "音声と入力", exact: true })
		.click();
	const save = artifact.getByRole("button", {
		name: "設定の変更をすべて保存",
		exact: true,
	});
	await expect(save).toBeDisabled();
	const volume = artifact.getByRole("slider", { name: /^音量/ });
	await volume.focus();
	await volume.press("Home");
	for (let i = 0; i < 11; i++) await volume.press("ArrowRight");
	await save.click();
	await expect(
		artifact.getByText("変更を適用しました", { exact: true }),
	).toBeVisible();
	expect((await client.settings()).voice.outputVolume).toBe(0.55);
	await artifact.getByRole("button", { name: "聞き取り", exact: true }).click();
	await artifact.getByText("詳細設定", { exact: true }).click();
	await artifact
		.getByLabel("発話を確定する無音時間（ミリ秒）", { exact: true })
		.fill("1900");
	await save.click();
	await expect(
		artifact.getByText("変更を適用しました", { exact: true }),
	).toBeVisible();
	expect((await client.settings()).voice.silenceMs).toBe(1900);
	await artifact.getByRole("button", { name: "機器", exact: true }).click();
	await artifact
		.getByRole("button", { name: "音声機器を確認", exact: true })
		.click();
	await artifact
		.getByLabel("マイク", { exact: true })
		.selectOption("direct-save-mic");
	await save.click();
	await expect(
		artifact.getByText("変更を適用しました", { exact: true }),
	).toBeVisible();
	expect((await client.settings()).voice.inputDevice).toBe("direct-save-mic");
	await expect(save).toBeDisabled();
	await page.reload();
	await openFromLauncher(page, "設定");
	await artifact
		.getByRole("button", { name: "音声と入力", exact: true })
		.click();
	await expect(artifact.getByRole("slider", { name: /^音量/ })).toHaveValue(
		"0.55",
	);
	await artifact.getByRole("button", { name: "聞き取り", exact: true }).click();
	await artifact.getByText("詳細設定", { exact: true }).click();
	await expect(
		artifact.getByLabel("発話を確定する無音時間（ミリ秒）", { exact: true }),
	).toHaveValue("1900");
	await artifact.getByRole("button", { name: "機器", exact: true }).click();
	await expect(artifact.getByLabel("マイク", { exact: true })).toHaveValue(
		"direct-save-mic",
	);
	await page.setViewportSize({ width: 390, height: 844 });
	await save.scrollIntoViewIfNeeded();
	await expect(save).toBeInViewport();
	await artifact.screenshot({
		path: "spec/verification/settings-voice-input-2026-10-13/voice-direct-save.png",
	});
});

test("voice/input OpenUI saves cloud and input fields, keeps closed drafts, and exposes only local capabilities", async ({
	page,
}) => {
	const client = createClient("http://127.0.0.1:" + apiPort, token);
	const settings = await client.settings();
	settings.larm.baseUrl = "http://127.0.0.1:1";
	const connectionId = crypto.randomUUID(),
		id = crypto.randomUUID();
	settings.connections.push({
		id: connectionId,
		name: "試験用クラウド",
		baseUrl: "https://example.test/v1",
		enabled: true,
		epoch: 0,
		envRef: null,
	});
	settings.resources.push({
		id,
		connectionId,
		purpose: "tts",
		model: "multilingual",
		voice: "alloy",
		contextWindow: null,
	});
	settings.routes.tts.fallbackId = id;
	await client.applySettings({
		requestId: crypto.randomUUID(),
		expectedRevision: settings.revision,
		settings,
		keys: [],
	});
	let catalogs = 0;
	await page.route("**/api/inference/voices", async (route) => {
		catalogs++;
		await route.fulfill({
			json: {
				model: "fixture-tts",
				default_voice: "fixture",
				voices: [
					{
						id: "fixture",
						display_name: "試験用キャラクター",
						styles: [{ id: "normal", display_name: "ノーマル" }],
						capabilities: {
							speed: { minimum: 0.8, maximum: 1.3, default: 1 },
							intonation_scale: { minimum: 0, maximum: 2, default: 1 },
						},
					},
				],
			},
		});
	});
	await page.addInitScript(() => {
		let requests = 0,
			stopped = 0;
		Object.defineProperty(navigator, "mediaDevices", {
			value: {
				getUserMedia: async () => {
					requests++;
					return {
						getTracks: () => [
							{
								stop: () => {
									stopped++;
								},
							},
						],
					};
				},
				enumerateDevices: async () => [
					{ deviceId: "fixture-mic", kind: "audioinput", label: "試験マイク" },
				],
			},
		});
		Object.assign(window, { fixtureDevices: () => ({ requests, stopped }) });
	});
	await page.goto("http://127.0.0.1:" + webPort);
	await openFromLauncher(page, "設定");
	const artifact = page.getByRole("complementary", {
		name: "アーティファクト",
	});
	await artifact
		.getByRole("button", { name: "音声と入力", exact: true })
		.click();
	await expect(
		artifact.getByLabel("キャラクター", { exact: true }),
	).toBeEnabled();
	expect(catalogs).toBeGreaterThan(0);
	await expect(
		artifact.getByLabel("話す速さ", { exact: false }),
	).toHaveAttribute("max", "1.3");
	await artifact.getByText("詳細設定", { exact: true }).click();
	await expect(
		artifact.getByLabel("話し方（スタイル）", { exact: true }),
	).toBeVisible();
	await expect(artifact.getByLabel("声の高さ", { exact: false })).toHaveCount(
		0,
	);
	await expect(
		artifact.getByText(/英語の声|英語の速さ|言語判定の接続先/),
	).toHaveCount(0);
	await artifact.screenshot({
		path: "spec/verification/settings-voice-input-2026-10-13/voice-local.png",
	});
	await artifact
		.getByLabel("調整する読み上げ先", { exact: true })
		.selectOption(id);
	await artifact.getByLabel(/の音声ID/).fill("nova");
	await artifact.getByRole("button", { name: "聞き取り", exact: true }).click();
	await artifact.getByLabel("英語", { exact: true }).uncheck();
	// The advanced input section retains its own controls under the shared details element.
	if (
		!(await artifact.getByLabel("発話を確定する無音時間（ミリ秒）").isVisible())
	)
		await artifact.getByText("詳細設定", { exact: true }).click();
	await artifact.getByLabel("発話を確定する無音時間（ミリ秒）").fill("1800");
	await artifact.getByRole("button", { name: "機器", exact: true }).click();
	expect(
		await page.evaluate(() =>
			(window as unknown as { fixtureDevices: () => unknown }).fixtureDevices(),
		),
	).toEqual({ requests: 0, stopped: 0 });
	await artifact
		.getByRole("button", { name: "音声機器を確認", exact: true })
		.click();
	await expect(artifact.getByText(/音声機器を確認しました/)).toBeVisible();
	await artifact
		.getByLabel("マイク", { exact: true })
		.selectOption("fixture-mic");
	expect(
		await page.evaluate(() =>
			(window as unknown as { fixtureDevices: () => unknown }).fixtureDevices(),
		),
	).toEqual({ requests: 1, stopped: 1 });
	await artifact
		.getByRole("button", { name: "音声と入力を閉じる", exact: true })
		.click();
	await artifact.getByRole("tab", { name: "設定", exact: true }).click();
	await artifact
		.getByRole("button", { name: "音声と入力", exact: true })
		.click();
	await artifact.getByRole("button", { name: "聞き取り", exact: true }).click();
	await expect(artifact.getByLabel("英語", { exact: true })).not.toBeChecked();
	await artifact.getByRole("button", { name: "変更一覧を開く" }).click();
	await expect(
		artifact.getByText("音声と入力 / 利用する言語", { exact: true }),
	).toBeVisible();
	await expect(
		artifact.getByText("既存の設定画面の変更", { exact: true }),
	).toHaveCount(0);
	await artifact
		.getByRole("button", { name: "設定の変更をすべて適用" })
		.click();
	await expect(
		artifact.getByText("変更を適用しました", { exact: true }),
	).toBeVisible();
	const saved = await client.settings();
	expect(saved.voice.inputDevice).toBe("fixture-mic");
	expect(saved.voice.silenceMs).toBe(1800);
	expect(saved.general.asrLanguages).toEqual(["ja"]);
	expect(saved.resources.find((r) => r.id === id)?.voice).toBe("nova");
	// Cloud-only configuration must not fetch the local catalogue after reload.
	saved.routes.tts.mode = "cloud-only";
	await client.applySettings({
		requestId: crypto.randomUUID(),
		expectedRevision: saved.revision,
		settings: saved,
		keys: [],
	});
	await page.reload();
	catalogs = 0;
	await openFromLauncher(page, "設定");
	await artifact
		.getByRole("button", { name: "音声と入力", exact: true })
		.click();
	await expect(artifact.getByLabel(/の音声ID/)).toHaveValue("nova");
	await expect(
		artifact.getByLabel("キャラクター", { exact: true }),
	).toHaveCount(0);
	expect(catalogs).toBe(0);
	await artifact.screenshot({
		path: "spec/verification/settings-voice-input-2026-10-13/voice-cloud.png",
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await artifact.getByRole("button", { name: "聞き取り", exact: true }).click();
	await artifact.locator(".ds-settings-panel").screenshot({
		path: "spec/verification/settings-voice-input-2026-10-13/input-narrow.png",
	});
	await artifact
		.getByRole("button", { name: "利用先を変更", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "AIの使い方", exact: true }),
	).toBeVisible();
	expect(await page.evaluate(() => window.location.hash)).toBe("#settings/ai");
	await page.getByRole("button", { name: "会話に戻る", exact: true }).click();
	await expect(
		artifact.getByRole("button", { name: "聞き取り", exact: true }),
	).toBeVisible();
});
