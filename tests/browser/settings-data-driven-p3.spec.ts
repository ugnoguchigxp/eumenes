import { test, expect, type Page } from "@playwright/test";
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
	await expect(screen.getByText("記憶の履歴", { exact: true }).last()).toBeVisible();
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

test("world: the screen opens with its status and empty lists", async ({
	page,
}) => {
	await openHub(page);
	await openFromHub(page, "World");
	const screen = panel(page);
	for (const title of ["Worldの状態", "主張の一覧", "忘却の状況"])
		await expect(
			screen.getByText(title, { exact: true }).first(),
		).toBeVisible();
	await expect(
		screen.getByRole("cell", { name: "オン", exact: true }),
	).toBeVisible();
	await expect(screen.getByText("項目はありません。")).toHaveCount(2);
	await expect(screen.getByRole("alert")).toHaveCount(0);
});

test("service tests: the catalog and the status are shown", async ({
	page,
}) => {
	await openHub(page);
	await openFromHub(page, "動作確認");
	const screen = panel(page);
	for (const title of [
		"サービスの一覧",
		"試せるサービス",
		"確認の履歴",
		"Healthの結果",
	])
		await expect(
			screen.getByText(title, { exact: true }).first(),
		).toBeVisible();
	await expect(
		screen.getByRole("cell", { name: "更新が必要です", exact: true }),
	).toBeVisible();
	await expect(
		screen.getByRole("button", { name: "一覧を更新" }),
	).toBeVisible();
	await expect(
		screen.getByRole("button", { name: "Healthを確認" }),
	).toBeVisible();
	const answered = nextAction(page);
	await screen.getByRole("button", { name: "一覧を更新" }).click();
	expect((await (await answered).json()).status).toBe("accepted");
	// No LARM is configured on this fixture: the list is read again and reports the failure.
	await expect(
		screen.getByRole("cell", { name: "最新", exact: true }),
	).toBeVisible();
	await expect(screen.getByText(/確認に失敗しました/).first()).toBeVisible();
});
