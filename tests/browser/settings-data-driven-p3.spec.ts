import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createFixture } from "./fixture";

const TOKEN = "fixture-token-for-toolchain-browser";
const TITLE = "設定";

test.setTimeout(90000);
let apiPort: number, webPort: number;
const fixture = createFixture();
const auth = { authorization: `Bearer ${TOKEN}` };

test.beforeAll(async () => {
	apiPort = await fixture.port();
	webPort = await fixture.port();
	await fixture.launch(
		["scripts/settings-fixture-server.ts"],
		{
			EUMENES_PORT: String(apiPort),
			EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
		},
		{ ports: [apiPort] },
	);
	await fixture.launchWeb({
		webPort,
		apiPort,
		token: TOKEN,
		cacheDir: `/tmp/eumenes-settings-p3-vite-${webPort}`,
	});
	await fixture.waitUntil(
		async () => {
			const web = await fetch(`http://127.0.0.1:${webPort}`);
			const api = await fetch(`http://127.0.0.1:${apiPort}/api/settings`, {
				headers: auth,
			});
			return web.ok && api.ok;
		},
		{ message: "fixture_not_ready" },
	);
});

test.afterAll(async () => {
	await fixture.stopAll();
});

async function openHub(page: Page) {
	await page.goto(`http://127.0.0.1:${webPort}`);
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await page.getByRole("menuitem", { name: TITLE, exact: true }).click();
	await expect(page.getByRole("button", { name: "会話" })).toBeVisible();
}

/** From the hub, opens one registered screen in its own tab. */
async function openFromHub(page: Page, label: string) {
	await page.getByRole("button", { name: label, exact: true }).click();
	await expect(
		page
			.getByRole("tablist", { name: "アーティファクトのタブ" })
			.getByRole("tab", { selected: true }),
	).not.toHaveText(TITLE);
}

type Request = import("@playwright/test").APIRequestContext;
const CONFLICT = /状態が変わりました/;

async function dictionary(request: Request) {
	const response = await request.get(
		`http://127.0.0.1:${apiPort}/api/tts-dictionary`,
		{ headers: auth },
	);
	expect(response.ok()).toBe(true);
	return (
		(await response.json()) as {
			entries: Array<{ written: string; spoken: string }>;
		}
	).entries;
}

/** Another writer changes an entry through the public dictionary API. */
async function otherSaves(
	request: Request,
	written: string,
	was: string,
	spoken: string,
) {
	const response = await request.post(
		`http://127.0.0.1:${apiPort}/api/tts-dictionary/save`,
		{
			headers: auth,
			data: {
				original: written,
				entry: { written, spoken },
				expected: { spoken: was },
			},
		},
	);
	expect(response.ok()).toBe(true);
}

/** The next action request the page sends, with the ledger's answer. */
function nextAction(page: Page) {
	return page.waitForResponse(
		(r) =>
			r.request().method() === "POST" &&
			r.url().endsWith("/api/toolchain-actions"),
	);
}

test("hub lists the P3 screens", async ({ page }) => {
	await openHub(page);
	for (const name of ["読み方辞書", "記憶", "World", "動作確認"])
		await expect(
			page.getByRole("button", { name, exact: true }).last(),
		).toBeVisible();
});

test("dictionary: create, edit, delete, and every conflict is shown", async ({
	page,
	request,
}) => {
	await openHub(page);
	await openFromHub(page, "読み方辞書");
	const written = page.getByLabel(/^文字（必須）/);
	const spoken = page.getByLabel(/^読み方（必須）/);
	const create = async (w: string, s: string) => {
		await written.fill(w);
		await spoken.fill(s);
		const answered = nextAction(page);
		await page.getByRole("button", { name: "登録する" }).click();
		return (await (await answered).json()) as { status: string };
	};
	expect((await create("今日", "きょう")).status).toBe("accepted");
	await expect(page.getByRole("cell", { name: "きょう" })).toBeVisible();
	expect(await dictionary(request)).toEqual([
		{ written: "今日", spoken: "きょう" },
	]);
	// A create never replaces a registered headword.
	expect((await create("今日", "こんにち")).status).toBe("rejected");
	await expect(page.getByText(CONFLICT)).toBeVisible();
	expect(await dictionary(request)).toEqual([
		{ written: "今日", spoken: "きょう" },
	]);
	// A headword the dictionary refuses is rejected and saves nothing.
	expect((await create("あ、い", "えー")).status).toBe("rejected");
	expect(await dictionary(request)).toHaveLength(1);

	// Edit: the form starts from the row's reading.
	await page.getByRole("button", { name: "編集: 今日" }).click();
	const dialog = page.getByRole("dialog");
	const reading = dialog.getByLabel(/^読み方（必須）/);
	await expect(reading).toHaveValue("きょう");
	await reading.fill("こんにち");
	let answered = nextAction(page);
	await dialog.getByRole("button", { name: "編集", exact: true }).click();
	expect((await (await answered).json()).status).toBe("accepted");
	await expect(page.getByRole("cell", { name: "こんにち" })).toBeVisible();
	expect(await dictionary(request)).toEqual([
		{ written: "今日", spoken: "こんにち" },
	]);

	// Edit against a row somebody else already changed: a conflict, nothing is overwritten.
	await page.getByRole("button", { name: "編集: 今日" }).click();
	await otherSaves(request, "今日", "こんにち", "べつ");
	await dialog.getByLabel(/^読み方（必須）/).fill("さん");
	answered = nextAction(page);
	await dialog.getByRole("button", { name: "編集", exact: true }).click();
	expect((await (await answered).json()).errorCode).toBe("revision_conflict");
	await expect(page.getByText(CONFLICT)).toBeVisible();
	expect(await dictionary(request)).toEqual([
		{ written: "今日", spoken: "べつ" },
	]);
	// The form stays open for another try; the list behind it has been read again.
	await dialog.getByRole("button", { name: "ダイアログを閉じる" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByRole("cell", { name: "べつ" })).toBeVisible();

	// Delete asks first; a row changed in the meantime conflicts, then the fresh row is deleted.
	const row = page.getByRole("row", { name: /今日/ });
	await row.getByRole("button", { name: "削除: 今日" }).click();
	await expect(page.getByText(/この読み方を辞書から削除します/)).toBeVisible();
	await otherSaves(request, "今日", "べつ", "ほか");
	answered = nextAction(page);
	await page.getByRole("button", { name: "実行する" }).click();
	expect((await (await answered).json()).errorCode).toBe("revision_conflict");
	expect(await dictionary(request)).toHaveLength(1);
	// The dialog stays open with the refusal; closing it shows the list read again.
	await expect(page.getByRole("dialog").getByText(CONFLICT)).toBeVisible();
	await page.getByRole("button", { name: "やめる" }).click();
	await expect(page.getByRole("cell", { name: "ほか" })).toBeVisible();
	await page.getByRole("button", { name: "削除: 今日" }).click();
	answered = nextAction(page);
	await page.getByRole("button", { name: "実行する" }).click();
	expect((await (await answered).json()).status).toBe("accepted");
	await expect(page.getByRole("cell", { name: "今日" })).toHaveCount(0);
	expect(await dictionary(request)).toEqual([]);
});

const panel = (page: Page) =>
	page.getByRole("tabpanel").filter({ visible: true }).first();

test("memory: sections are listed and the connection can be cut and restored", async ({
	page,
	request,
}) => {
	await openHub(page);
	await openFromHub(page, "記憶");
	const screen = panel(page);
	for (const title of [
		"会話への接続",
		"いつも使う記憶（長期）",
		"傾向",
		"最近の活動・メモ（短期）",
		"いまの文脈",
	])
		await expect(
			screen.getByText(title, { exact: true }).first(),
		).toBeVisible();
	await screen.getByRole("tab", { name: "記憶の履歴" }).click();
	await expect(
		screen.getByText("記憶の履歴", { exact: true }).last(),
	).toBeVisible();
	await screen.getByRole("tab", { name: "会話で使う記憶" }).click();
	await expect(
		screen.getByRole("cell", { name: "接続中", exact: true }),
	).toBeVisible();
	await screen.getByRole("button", { name: /^メモリーを切断/ }).click();
	await expect(page.getByText(/切断しても保存した記憶は残り/)).toBeVisible();
	let answered = nextAction(page);
	await page.getByRole("button", { name: "実行する" }).click();
	expect((await (await answered).json()).status).toBe("accepted");
	const enabled = async () =>
		(
			(await (
				await request.get(`http://127.0.0.1:${apiPort}/api/memory/status`, {
					headers: auth,
				})
			).json()) as { enabled: boolean }
		).enabled;
	expect(await enabled()).toBe(false);
	await expect(
		screen.getByRole("cell", { name: "非接続", exact: true }),
	).toBeVisible();
	await expect(
		screen.getByRole("button", { name: /^メモリーを切断/ }),
	).toHaveCount(0);
	answered = nextAction(page);
	await screen.getByRole("button", { name: /^メモリーを接続/ }).click();
	expect((await (await answered).json()).status).toBe("accepted");
	await expect(
		screen.getByRole("cell", { name: "接続中", exact: true }),
	).toBeVisible();
	expect(await enabled()).toBe(true);
});

test("world: status remains visible while the empty lists switch", async ({
	page,
}) => {
	await openHub(page);
	await openFromHub(page, "World");
	const screen = panel(page);
	await expect(
		screen.getByRole("status", { name: "World: オンライン" }),
	).toBeVisible();
	await expect(
		screen.getByRole("table", { name: "資料", exact: true }),
	).toBeVisible();
	await screen.getByRole("tab", { name: "主張の一覧", exact: true }).click();
	await expect(
		screen.getByRole("table", { name: "主張の一覧", exact: true }),
	).toBeVisible();
	await expect(
		screen.getByText("項目はありません。", { exact: true }),
	).toBeVisible();
	await screen.getByRole("tab", { name: "忘却の状況" }).click();
	await expect(
		screen.getByRole("tab", { name: "忘却の状況", selected: true }),
	).toBeVisible();
	await expect(
		screen.getByRole("status", { name: "World: オンライン" }),
	).toBeVisible();
	await expect(screen.getByRole("alert")).toHaveCount(0);
});

test("service tests: full-screen workbench and catalog refresh", async ({
	page,
}) => {
	await openHub(page);
	await openFromHub(page, "動作確認");
	const screen = page.getByRole("region", { name: "サービスを試す" });
	await expect(
		screen.getByRole("heading", { name: "サービスを試す" }),
	).toBeVisible();
	await expect(
		page.getByRole("separator", {
			name: "会話とアーティファクトのサイズを調整",
		}),
	).toHaveCount(0);
	await expect(screen.getByRole("group", { name: "接続先" })).toBeVisible();
	await expect(
		screen.getByRole("complementary", { name: "サービス一覧" }),
	).toBeVisible();
	await expect(
		screen.getByRole("searchbox", { name: "サービスを検索" }),
	).toBeVisible();
	await expect(
		screen.getByText(/設定が変わりました。一覧を更新/),
	).toBeVisible();
	await expect(
		screen.getByRole("button", { name: "一覧を更新" }),
	).toBeVisible();
	await expect(screen.getByRole("button", { name: "自己診断" })).toBeVisible();
	const answered = nextAction(page);
	await screen.getByRole("button", { name: "一覧を更新" }).click();
	expect((await (await answered).json()).status).toBe("accepted");
	// No LARM is configured on this fixture: the list is read again and reports the failure.
	await expect(screen.getByText(/一覧取得：/)).toBeVisible();
	await screen.getByText("一部の一覧を取得できませんでした").click();
	await expect(
		screen.getByText(/all：LARMの接続先URLが設定されていません/),
	).toBeVisible();
});

test("service tests: unapplied settings disable actions until applied", async ({
	page,
}) => {
	await openHub(page);
	await openFromHub(page, "会話");
	await page.getByLabel("AIの名前").fill("変更中の名前");
	await page.getByRole("tab", { name: "設定", exact: true }).click();
	await openFromHub(page, "動作確認");
	const screen = page.getByRole("region", { name: "サービスを試す" });
	await expect(screen.getByText(/設定に未適用の変更があります/)).toBeVisible();
	await expect(
		screen.getByRole("button", { name: "一覧を更新" }),
	).toBeDisabled();
	await expect(screen.getByRole("button", { name: "自己診断" })).toBeDisabled();
	await page.getByRole("tab", { name: "会話", exact: true }).click();
	await page.getByRole("button", { name: "変更一覧を開く" }).click();
	await page.getByRole("button", { name: "設定の変更をすべて適用" }).click();
	await page.getByRole("tab", { name: "動作確認", exact: true }).click();
	await expect(
		screen.getByRole("button", { name: "一覧を更新" }),
	).toBeEnabled();
});

test("service tests: selected service, input, result, and WAV control", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1600, height: 1100 });
	const target = (
		id: string,
		kind: string,
		kindCode: string,
		sourceCode: "larm" | "cloud" = "larm",
	) => ({
		id,
		name: sourceCode === "larm" ? "LARM" : "Cloud TTS",
		model: id,
		kind,
		kindCode,
		source: sourceCode === "larm" ? "LARM" : "クラウド",
		sourceName: sourceCode === "larm" ? "LARM" : "Cloud TTS",
		sourceCode,
		voiceInput: kindCode === "tts" && sourceCode === "larm",
		primary: true,
		onDemand: false,
		start: "対象を固定して実行",
		state: "試せます",
		testable: true,
		revision: 2,
		sample: "こんにちは。",
	});
	await page.route(
		"**/api/toolchain-artifacts/*/sources/service-tests-status",
		(route) =>
			route.fulfill({
				json: {
					revision: 2,
					data: [
						{
							id: "catalog",
							state: "最新",
							discoveredAt: Date.now(),
							targetCount: 7,
							errors: "",
							refresh: "",
							busy: false,
							catalogRevision: 2,
							diagnosisRevision: null,
							control: "未確認",
						},
					],
				},
			}),
	);
	await page.route(
		"**/api/toolchain-artifacts/*/sources/service-tests-catalog",
		(route) =>
			route.fulfill({
				json: {
					revision: 2,
					data: [
						{
							id: "image",
							name: "test-image-profile",
							model: "fixture-image",
							kind: "画像生成",
							kindCode: "image",
							source: "LARM",
							sourceName: "LARM",
							sourceCode: "larm",
							voiceInput: false,
							primary: true,
							onDemand: true,
							start: "実行時に起動",
							state: "試せます",
							testable: true,
							revision: 2,
							sample: "朝の光が入る静かな書斎。木の机と観葉植物。",
						},
						{
							id: "asr",
							name: "音声認識",
							model: "fixture-asr",
							kind: "音声認識",
							kindCode: "asr",
							source: "LARM",
							sourceName: "LARM",
							sourceCode: "larm",
							voiceInput: false,
							primary: true,
							onDemand: false,
							start: "常駐",
							state: "試せます",
							testable: true,
							revision: 2,
							sample: "無音サンプル",
						},
						target("embedding", "埋め込み", "embedding"),
						target("tts-larm", "音声合成", "tts"),
						target("decision", "判断", "decision"),
						target("music", "楽曲生成", "music"),
						target("tts-cloud", "音声合成", "tts", "cloud"),
					],
				},
			}),
	);
	await page.route(
		"**/api/toolchain-artifacts/*/sources/service-tests-runs",
		(route) =>
			route.fulfill({
				json: {
					revision: 1,
					data: [
						{
							id: "11111111-1111-4111-8111-111111111111",
							targetId: "image",
							model: "fixture-image",
							kindCode: "image",
							status: "succeeded",
							statusLabel: "成功",
							phase: "完了",
							created: Date.now() - 5000,
							ended: Date.now(),
							error: "",
							text: "生成が完了しました。",
							revision: 2,
							retryArtifact: false,
							preview: null,
						},
					],
				},
			}),
	);
	await openHub(page);
	await openFromHub(page, "動作確認");
	const screen = page.getByRole("region", { name: "サービスを試す" });
	await expect(screen.getByRole("heading", { name: "画像生成" })).toBeVisible();
	await expect(screen.getByRole("textbox", { name: "プロンプト" })).toHaveValue(
		/朝の光/,
	);
	await expect(
		screen.getByRole("spinbutton", { name: "幅（px）" }),
	).toHaveValue("512");
	await screen.getByRole("spinbutton", { name: "幅（px）" }).fill("99");
	await expect(
		screen.getByRole("button", { name: "▶ 画像を生成" }),
	).toBeDisabled();
	await screen.getByRole("spinbutton", { name: "幅（px）" }).fill("512");
	await expect(
		screen
			.getByRole("region", { name: "結果" })
			.getByText("生成が完了しました。"),
	).toBeVisible();
	const dir = "spec/verification/settings-service-tests-data-driven-2026-10-14";
	mkdirSync(dir, { recursive: true });
	await screen.screenshot({ path: `${dir}/desktop.png` });
	await page.emulateMedia({ colorScheme: "dark" });
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	await screen.screenshot({ path: `${dir}/desktop-dark.png` });
	await screen.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	await screen.screenshot({ path: `${dir}/desktop-detail-dark.png` });
	await screen.evaluate((element) => {
		element.scrollTop = 0;
	});
	await screen.getByRole("button", { name: /音声認識.*fixture-asr/ }).click();
	await expect(
		screen.getByLabel("音声ファイル（WAV・4 MBまで）"),
	).toBeVisible();
	await expect(screen.getByText(/無音サンプルで通信を確認/)).toBeVisible();
	await expect(screen.getByRole("textbox", { name: "文章" })).toHaveCount(0);
	await screen
		.getByLabel("音声ファイル（WAV・4 MBまで）")
		.setInputFiles("tests/browser/fixtures/speech.wav");
	await expect(screen.getByText("speech.wav")).toBeVisible();
	await screen.screenshot({ path: `${dir}/asr-dark.png` });
	await screen.getByRole("button", { name: /埋め込み.*embedding/ }).click();
	await expect(
		screen.getByRole("textbox", { name: "比較する文章" }),
	).toHaveValue("窓のそばで猫が寝ています。");
	await screen.getByRole("button", { name: /音声合成.*tts-larm/ }).click();
	await expect(
		screen.getByRole("textbox", { name: "声のID（空欄で既定の声）" }),
	).toBeVisible();
	await screen.getByRole("button", { name: /判断.*decision/ }).click();
	await expect(screen.getByText(/挨拶.*質問・依頼/)).toBeVisible();
	await screen.getByRole("button", { name: /楽曲生成.*music/ }).click();
	await expect(screen.getByRole("textbox", { name: "曲の説明" })).toBeVisible();
	await expect(
		screen.getByRole("combobox", { name: "長さ（秒）" }),
	).toHaveValue("10");
	await expect(
		screen.getByRole("combobox", { name: "長さ（秒）" }).locator("option"),
	).toHaveText(["5秒", "10秒", "20秒", "30秒"]);
	await expect(screen.getByText(/歌声なし・MP3/)).toBeVisible();
	await screen.getByRole("button", { name: "登録済みクラウド" }).click();
	await screen.getByRole("button", { name: /音声合成.*tts-cloud/ }).click();
	await expect(
		screen.getByRole("textbox", { name: "声のID（空欄で既定の声）" }),
	).toHaveCount(0);
});

test("service tests: diagnosis, cancellation and saved preview remain available", async ({
	page,
}) => {
	const now = Date.now();
	await page.route(
		"**/api/toolchain-artifacts/*/sources/service-tests-status",
		(route) =>
			route.fulfill({
				json: {
					revision: 2,
					data: [
						{
							id: "catalog",
							state: "最新",
							discoveredAt: now,
							targetCount: 1,
							errors: "",
							refresh: "",
							refreshGeneration: 0,
							busy: true,
							catalogRevision: 2,
							diagnosisRevision: 2,
							control: "正常",
						},
					],
				},
			}),
	);
	await page.route(
		"**/api/toolchain-artifacts/*/sources/service-tests-catalog",
		(route) =>
			route.fulfill({
				json: {
					revision: 2,
					data: [
						{
							id: "image",
							name: "test-image-profile",
							model: "fixture-image",
							kind: "画像生成",
							kindCode: "image",
							source: "LARM",
							sourceName: "LARM",
							sourceCode: "larm",
							voiceInput: false,
							primary: true,
							onDemand: true,
							start: "実行時に起動",
							state: "試せます",
							testable: true,
							revision: 2,
							sample: "朝の光が入る静かな書斎。",
						},
					],
				},
			}),
	);
	await page.route(
		"**/api/toolchain-artifacts/*/sources/service-tests-runs",
		(route) =>
			route.fulfill({
				json: {
					revision: 3,
					data: [
						{
							id: "22222222-2222-4222-8222-222222222222",
							targetId: "image",
							kindCode: "image",
							model: "fixture-image",
							status: "running",
							statusLabel: "実行中",
							phase: "起動・生成を待っています",
							created: now,
							ended: null,
							error: "",
							text: "",
							revision: 2,
							progress: 0.2,
							previewAvailable: false,
							retryArtifact: false,
							preview: null,
						},
						{
							id: "33333333-3333-4333-8333-333333333333",
							targetId: "diagnostics",
							kindCode: "diagnostics",
							model: "全サービス",
							status: "succeeded",
							statusLabel: "成功",
							phase: "診断完了",
							created: now - 5000,
							ended: now - 4000,
							error: "",
							text: "",
							revision: 2,
							previewAvailable: false,
							retryArtifact: false,
							preview: null,
						},
						{
							id: "11111111-1111-4111-8111-111111111111",
							targetId: "image",
							kindCode: "image",
							model: "fixture-image",
							status: "succeeded",
							statusLabel: "成功",
							phase: "成功",
							created: now - 9000,
							ended: now - 8000,
							error: "",
							text: "生成しました。",
							revision: 2,
							previewAvailable: true,
							retryArtifact: false,
							preview: {
								path: "/api/service-tests/runs/11111111-1111-4111-8111-111111111111/artifact",
								mime: "image/png",
							},
						},
					],
				},
			}),
	);
	await page.route(
		"**/api/toolchain-artifacts/*/sources/service-tests-health",
		(route) =>
			route.fulfill({
				json: {
					revision: 3,
					data: [
						{
							targetId: "image",
							name: "画像生成",
							model: "fixture-image",
							state: "正常",
							reason: "",
							checkedAt: now - 4000,
							latencyMs: 10,
							running: false,
						},
					],
				},
			}),
	);
	await page.route("**/api/service-tests/runs/*/artifact", (route) =>
		route.fulfill({
			contentType: "image/png",
			body: Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
				"base64",
			),
		}),
	);
	await openHub(page);
	await openFromHub(page, "動作確認");
	const screen = page.getByRole("region", { name: "サービスを試す" });
	await expect(
		screen.getByRole("button", { name: "待機を終了" }),
	).toBeVisible();
	await expect(screen.getByText(/待機を終了しても生成が続く/)).toBeVisible();
	await screen.getByText(/自己診断の結果/).click();
	await expect(screen.getByText("LARM本体：正常")).toBeVisible();
	await expect(screen.getByText("fixture-image").last()).toBeVisible();
	await screen.getByText(/実行履歴/).click();
	await screen.getByRole("button", { name: /成功/ }).click();
	await expect(screen.getByRole("img", { name: "生成した画像" })).toBeVisible();
	await expect(
		screen.getByRole("link", { name: "結果を保存" }),
	).toHaveAttribute("download", /\.png$/);
	await expect(
		screen.getByRole("img", { name: "生成した画像" }).locator(".."),
	).toHaveAttribute("target", "_blank");
});
