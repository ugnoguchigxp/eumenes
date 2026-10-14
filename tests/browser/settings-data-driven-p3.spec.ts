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
const DOTS = "Codexへの委任";

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
	for (const name of ["読み方辞書", "記憶", "World", DOTS, "動作確認"])
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
	await dialog.getByRole("button", { name: "Close" }).click();
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

test("dots: creating a connection shows the token once", async ({ page }) => {
	await openHub(page);
	await openFromHub(page, DOTS);
	await panel(page).getByRole("tab", { name: "dotsへの接続" }).click();
	const form = page.getByRole("form", { name: "接続を作成" });
	await form.getByLabel(/^名前（必須）/).fill("ローカルdots");
	const answered = nextAction(page);
	await form.getByRole("button", { name: "接続を作成" }).click();
	expect((await (await answered).json()).status).toBe("accepted");
	const dialog = page.getByRole("dialog", { name: "一度だけ表示する値" });
	await expect(dialog).toBeVisible();
	const token = (await dialog.getByText(/^[0-9a-f]{64}$/).innerText()).trim();
	await dialog.getByRole("button", { name: "閉じる" }).click();
	await expect(dialog).toHaveCount(0);
	// The connection is listed, the secret is nowhere on the page any more.
	await expect(
		panel(page).getByRole("cell", { name: "ローカルdots", exact: true }),
	).toBeVisible();
	await expect(page.getByText(token)).toHaveCount(0);
	await page.reload();
	await expect(page.getByText(token)).toHaveCount(0);
	const stored = await page.evaluate(
		() => JSON.stringify(sessionStorage) + JSON.stringify(localStorage),
	);
	expect(stored).not.toContain(token);
	// The list survives a reload without ever offering the value again.
	await openHub(page);
	await openFromHub(page, DOTS);
	await panel(page).getByRole("tab", { name: "dotsへの接続" }).click();
	await expect(
		panel(page).getByRole("cell", { name: "ローカルdots", exact: true }),
	).toBeVisible();
	await expect(page.getByText(token)).toHaveCount(0);
});

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
	for (const title of ["Worldの状態", "主張の一覧"])
		await expect(
			screen.getByText(title, { exact: true }).first(),
		).toBeVisible();
	await expect(
		screen.getByRole("definition").filter({ hasText: "オン" }),
	).toBeVisible();
	await expect(
		screen.getByLabel("主張の一覧の一覧").getByText("項目はありません。"),
	).toBeVisible();
	await screen.getByRole("tab", { name: "忘却の状況" }).click();
	await expect(
		screen.getByRole("tab", { name: "忘却の状況", selected: true }),
	).toBeVisible();
	await expect(
		screen.getByRole("definition").filter({ hasText: "オン" }),
	).toBeVisible();
	await expect(screen.getByRole("alert")).toHaveCount(0);
});

test("service tests: full-screen workbench and catalog refresh", async ({
	page,
}) => {
	await openHub(page);
	await openFromHub(page, "動作確認");
	const screen = panel(page);
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
	await expect(screen.getByText(/確認に失敗しました/).first()).toBeVisible();
});

test("service tests: selected service, input, result, and WAV control", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1600, height: 1100 });
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
							targetCount: 2,
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
							name: "SAAA-w-Image",
							model: "qwen-image-2.1-turbo",
							kind: "画像生成",
							kindCode: "image",
							source: "LARM",
							sourceCode: "larm",
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
							model: "qwen-asr",
							kind: "音声認識",
							kindCode: "asr",
							source: "LARM",
							sourceCode: "larm",
							primary: true,
							onDemand: false,
							start: "常駐",
							state: "試せます",
							testable: true,
							revision: 2,
							sample: "無音サンプル",
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
					revision: 1,
					data: [
						{
							id: "11111111-1111-4111-8111-111111111111",
							targetId: "image",
							model: "qwen-image-2.1-turbo",
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
	const screen = panel(page);
	await expect(screen.getByRole("heading", { name: "画像生成" })).toBeVisible();
	await expect(screen.getByRole("textbox", { name: "入力する文" })).toHaveValue(
		/朝の光/,
	);
	await expect(
		screen.getByRole("spinbutton", { name: "幅（画像）" }),
	).toHaveValue("512");
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
	await screen.getByRole("button", { name: /音声認識.*qwen-asr/ }).click();
	await expect(
		screen.getByLabel("音声ファイル（WAV・4 MBまで）"),
	).toBeVisible();
	await expect(screen.getByText(/無音サンプルで通信を確認/)).toBeVisible();
	await screen
		.getByLabel("音声ファイル（WAV・4 MBまで）")
		.setInputFiles("tests/browser/fixtures/speech.wav");
	await expect(screen.getByText("speech.wav")).toBeVisible();
});
