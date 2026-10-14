import { test, expect, type Page } from "@playwright/test";
import { createFixture } from "./fixture";

const TOKEN = "fixture-token-for-toolchain-browser";
/** The registered (data-driven) settings entry; the legacy 「設定」 stays beside it. */
const TITLE = "設定（データドリブン）";

test.setTimeout(60000);
let apiPort: number, webPort: number;
const fixture = createFixture();
const auth = { authorization: `Bearer ${TOKEN}` };

test.beforeAll(async () => {
	apiPort = await fixture.port();
	webPort = await fixture.port();
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
		token: TOKEN,
		cacheDir: `/tmp/eumenes-settings-data-vite-${webPort}`,
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

async function savedSettings(
	request: import("@playwright/test").APIRequestContext,
) {
	const response = await request.get(
		`http://127.0.0.1:${apiPort}/api/settings`,
		{ headers: auth },
	);
	expect(response.ok()).toBe(true);
	return (await response.json()) as {
		revision: number;
		general: { agentName: string; userName: string; persona: string };
		[key: string]: unknown;
	};
}

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

test("the launcher has one data-driven entry beside the legacy settings, and no per-screen entries", async ({
	page,
}) => {
	await page.goto(`http://127.0.0.1:${webPort}`);
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await expect(
		page.getByRole("menuitem", { name: TITLE, exact: true }),
	).toHaveCount(1);
	await expect(
		page.getByRole("menuitem", { name: "設定", exact: true }),
	).toHaveCount(1);
	// Screens with a group are reached through the hub, not the top menu.
	for (const hidden of ["会話", "表示", "音声と入力", "記録", "変更一覧"])
		await expect(
			page.getByRole("menuitem", { name: hidden, exact: true }),
		).toHaveCount(0);
	await page.getByRole("menuitem", { name: TITLE, exact: true }).click();
	for (const name of ["会話", "音声と入力", "表示", "記録"])
		await expect(page.getByRole("button", { name })).toBeVisible();
	// Nothing opens by itself and the legacy page is untouched.
	await expect(
		page
			.getByRole("tablist", { name: "アーティファクトのタブ" })
			.getByRole("tab"),
	).toHaveCount(1);
});

test("hub to conversation: edit, review, apply persists to the settings API", async ({
	page,
	request,
}) => {
	const before = await savedSettings(request);
	await openHub(page);
	await openFromHub(page, "会話");
	await page.getByLabel("AIの名前").fill("データドリブン");
	await page.getByLabel("口調").selectOption("strategist");
	const save = page.getByRole("button", { name: "設定の変更をすべて保存" });
	await expect(save).toBeEnabled();
	await page.getByRole("button", { name: "変更一覧を開く" }).click();
	await expect(page.getByText("会話 / 口調")).toBeVisible();
	const applied = page.waitForResponse(
		(response) =>
			response.request().method() === "POST" &&
			response.url().endsWith("/api/toolchain-actions"),
	);
	await page.getByRole("button", { name: "設定の変更をすべて適用" }).click();
	const view = await (await applied).json();
	expect(view.status).toBe("accepted");
	// The conversation tab stays mounted behind this one; only the visible message counts.
	await expect(
		page.getByRole("status").filter({ hasText: "変更を適用しました" }),
	).toBeVisible();
	const saved = await savedSettings(request);
	expect(saved.general.agentName).toBe("データドリブン");
	expect(saved.general.persona).toBe("strategist");
	expect(saved.revision).toBeGreaterThan(before.revision);
	// The change list is empty again and the screen shows the saved values.
	await expect(
		page.getByRole("button", { name: "設定の変更をすべて適用" }),
	).toBeDisabled();
});

test("a revision conflict keeps the draft and nothing is resent", async ({
	page,
	request,
}) => {
	const current = await savedSettings(request);
	// This page keeps seeing the document as it was before the other save.
	await page.route("**/api/settings", (route) =>
		route.request().method() === "GET"
			? route.fulfill({ json: current })
			: route.continue(),
	);
	await openHub(page);
	await openFromHub(page, "会話");
	await page.getByLabel("あなたの名前").fill("競合の確認");
	// Someone else saves first, through the same public settings API.
	const other = await request.post(
		`http://127.0.0.1:${apiPort}/api/settings/apply`,
		{
			headers: auth,
			data: {
				requestId: crypto.randomUUID(),
				expectedRevision: current.revision,
				settings: {
					...current,
					general: { ...current.general, agentName: "別の画面" },
				},
				keys: [],
			},
		},
	);
	expect(other.ok()).toBe(true);
	let sends = 0;
	page.on("request", (r) => {
		if (r.method() === "POST" && r.url().endsWith("/api/toolchain-actions"))
			sends++;
	});
	await page.getByRole("button", { name: "設定の変更をすべて保存" }).click();
	await expect(
		page.getByText(/別の画面で設定が変更されました/).first(),
	).toBeVisible();
	await expect(page.getByLabel("あなたの名前")).toHaveValue("競合の確認");
	expect(sends).toBe(1);
	expect((await savedSettings(request)).general.userName).not.toBe(
		"競合の確認",
	);
	// The draft is still there to apply once the page has read the new revision.
	await expect(
		page.getByRole("button", { name: "設定の変更をすべて保存" }),
	).toBeEnabled();
});

test("display previews the subtitle before saving", async ({
	page,
	request,
}) => {
	const before = await savedSettings(request);
	await openHub(page);
	await openFromHub(page, "表示");
	await page.getByLabel("字幕のデザイン").selectOption("classic");
	await page.getByLabel("字幕の大きさ").selectOption("xlarge");
	const subtitle = page.getByTestId("subtitle");
	await expect(subtitle).toHaveAttribute("data-style", "classic");
	await expect(subtitle).toHaveAttribute("data-size", "xlarge");
	// Nothing is saved until the draft is applied.
	expect(await savedSettings(request)).toEqual(before);
});

test("voice and input show the registered fields and their groups", async ({
	page,
}) => {
	await openHub(page);
	await openFromHub(page, "音声と入力");
	await expect(page.getByLabel("回答を読み上げる")).toBeVisible();
	await expect(page.getByLabel(/^音量/)).toBeVisible();
	for (const group of ["読み上げ", "聞き取り", "機器"])
		await expect(page.getByRole("button", { name: group })).toBeVisible();
	await page.getByRole("button", { name: "聞き取り" }).click();
	await expect(page.getByLabel("日本語")).toBeVisible();
	await page.getByRole("button", { name: "機器" }).click();
	await expect(page.getByLabel("マイク", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "音声機器を確認" }),
	).toBeVisible();
});

test("records show the tables and search through the source read, not an action", async ({
	page,
}) => {
	await openHub(page);
	await openFromHub(page, "記録");
	await expect(page.getByRole("tab", { name: "AIの利用" })).toBeVisible();
	await expect(page.getByRole("tab", { name: "ツールチェーン" })).toBeVisible();
	let posts = 0;
	page.on("request", (r) => {
		if (r.method() === "POST" && r.url().endsWith("/api/toolchain-actions"))
			posts++;
	});
	const search = page.getByLabel(/を検索$/).first();
	await search.fill("model");
	const read = page.waitForResponse(
		(response) =>
			response.url().includes("/sources/settings-records") &&
			response.url().includes("params="),
	);
	await search.press("Enter");
	const response = await read;
	expect(response.ok()).toBe(true);
	const params = JSON.parse(
		new URL(response.url()).searchParams.get("params")!,
	);
	expect(params).toMatchObject({ q: "model", pageIndex: 0 });
	expect(posts).toBe(0);
	// The table answers from the same page shape the first read returned.
	await expect(page.getByLabel(/を検索$/).first()).toHaveValue("model");
});
