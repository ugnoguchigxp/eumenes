import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createFixture } from "./fixture";
import { openFromLauncher } from "./artifact-launcher";
import { createClient } from "../../client";

const fixture = createFixture();
const token = "settings-records-fixture-token-20261013";
let dir: string, apiPort: number, webPort: number;
// Three server tables, search/sort/page state, six deletes, downloads and reload share this budget.
test.setTimeout(180_000);
test.beforeAll(async () => {
	[apiPort, webPort] = (await fixture.ports(2)) as [number, number];
	dir = mkdtempSync(join(tmpdir(), "eumenes-records-"));
	const db = join(dir, "fixture.sqlite3");
	const seeded = spawnSync(
		"bun",
		["tests/browser/settings-records-seed.fixture.ts", db],
		{
			encoding: "utf8",
			env: { ...process.env, EUMENES_LOG_FILE: join(dir, "seed.jsonl") },
		},
	);
	if (seeded.status !== 0) throw new Error(seeded.stderr);
	await fixture.launch(
		["api/application/server.ts"],
		{
			EUMENES_DB: db,
			EUMENES_TOOLCHAIN_ENABLED: "0",
			EUMENES_LOG_FILE: join(dir, "api.jsonl"),
			EUMENES_API_TOKEN: token,
			EUMENES_SECRET_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
			EUMENES_PORT: String(apiPort),
			EUMENES_ORIGIN: "http://127.0.0.1:" + webPort,
		},
		{ ports: [apiPort] },
	);
	await fixture.ready(`http://127.0.0.1:${apiPort}/api/status`);
	await fixture.launchWeb({
		apiPort,
		webPort,
		token,
		cacheDir: join(dir, "vite"),
	});
	await fixture.ready(`http://127.0.0.1:${webPort}`);
});
test.afterAll(async () => {
	await fixture.stopAll();
	if (dir) rmSync(dir, { recursive: true, force: true });
});

test("API table sorting/search/pagination cover unloaded records and retain each tab's conditions", async ({
	page,
}) => {
	const client = createClient(`http://127.0.0.1:${apiPort}`, token);
	const saved = await client.settings();
	const requests: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes("/page?")) requests.push(request.url());
	});
	await page.goto(`http://127.0.0.1:${webPort}`);
	await openFromLauncher(page, "設定");
	const artifact = page.getByRole("complementary", {
		name: "アーティファクト",
	});
	await artifact.getByRole("button", { name: "記録", exact: true }).click();
	const ai = artifact.getByRole("tabpanel", { name: "AIの利用", exact: true });
	const aiTable = ai.getByRole("table", { name: "AIの利用", exact: true });
	await expect(
		ai.getByText("125件 · 1 / 13ページ", { exact: true }),
	).toBeVisible();
	await expect(aiTable.locator("tbody tr")).toHaveCount(10);
	await expect(aiTable.locator("tbody tr").first()).toContainText(
		"fixture-model-124",
	);
	await ai.getByLabel("AIの利用を検索").fill("fixture-model-000");
	await ai.getByLabel("AIの利用を検索").press("Enter");
	await expect(aiTable.locator("tbody tr")).toHaveCount(1);
	await expect(aiTable).toContainText("fixture-model-000");
	await aiTable.getByRole("button", { name: /の詳細$/ }).click();
	await expect(ai.getByText("120 / 48", { exact: true })).toBeVisible();
	await ai.getByRole("button", { name: "検索を解除" }).click();
	await expect(
		ai.getByText("125件 · 1 / 13ページ", { exact: true }),
	).toBeVisible();
	await ai.getByRole("button", { name: "AIの利用の次のページ" }).click();
	await expect(
		ai.getByText("125件 · 2 / 13ページ", { exact: true }),
	).toBeVisible();
	await expect(aiTable.locator("tbody tr").first()).toContainText(
		"fixture-model-114",
	);
	await ai.getByLabel("AIの利用の表示件数").selectOption("50");
	await expect(aiTable.locator("tbody tr")).toHaveCount(50);
	await expect(
		ai.getByText("125件 · 1 / 3ページ", { exact: true }),
	).toBeVisible();
	await ai.getByLabel("AIの利用を検索").fill("fixture-model-0");
	await ai.getByLabel("AIの利用を検索").press("Enter");
	await expect(
		ai.getByText("100件 · 1 / 2ページ", { exact: true }),
	).toBeVisible();
	await ai
		.getByRole("columnheader", { name: /モデル/ })
		.getByRole("button")
		.click();
	await expect(aiTable.locator("tbody tr").first()).toContainText(
		"fixture-model-000",
	);
	await expect(
		ai.getByRole("columnheader", { name: /モデル/ }),
	).toHaveAttribute("aria-sort", "ascending");
	const scroll = ai.getByRole("region", { name: "AIの利用の表" });
	await scroll.evaluate((el) => {
		el.scrollTop = 80;
	});
	const position = await scroll.evaluate((el) => el.scrollTop);
	await artifact
		.getByRole("tab", { name: "ツールチェーン", exact: true })
		.click();
	const tc = artifact.getByRole("tabpanel", {
		name: "ツールチェーン",
		exact: true,
	});
	const tcTable = tc.getByRole("table", {
		name: "ツールチェーン",
		exact: true,
	});
	await expect(tcTable.locator("tbody tr")).toHaveCount(10);
	await tc
		.getByRole("columnheader", { name: /処理/ })
		.getByRole("button")
		.click();
	await expect(tc.getByRole("columnheader", { name: /処理/ })).toHaveAttribute(
		"aria-sort",
		"ascending",
	);
	await tc
		.getByRole("columnheader", { name: /処理/ })
		.getByRole("button")
		.click();
	await expect(tcTable.locator("tbody tr").first()).toContainText(
		"fixture_search_054",
	);
	await tc.getByRole("button", { name: "ツールチェーンの次のページ" }).click();
	await expect(
		tc.getByText("55件 · 2 / 6ページ", { exact: true }),
	).toBeVisible();
	await expect(tcTable.locator("tbody tr").first()).toContainText(
		"fixture_search_044",
	);
	await tc.getByLabel("ツールチェーンを検索").fill("固定試験の依頼 54");
	await tc.getByLabel("ツールチェーンを検索").press("Enter");
	await expect(tcTable.locator("tbody tr")).toHaveCount(1);
	await expect(tcTable).toContainText("fixture_search_054");
	await tcTable.getByRole("button", { name: /の詳細$/ }).click();
	await expect(
		tc.getByText("固定試験の依頼 54", { exact: true }),
	).toBeVisible();
	await expect(tc.getByRole("table", { name: "提示した候補" })).toBeVisible();
	await artifact.getByRole("tab", { name: "AIの利用", exact: true }).click();
	await expect(ai.getByLabel("AIの利用を検索")).toHaveValue("fixture-model-0");
	await expect(
		ai.getByText("100件 · 1 / 2ページ", { exact: true }),
	).toBeVisible();
	await expect(
		ai.getByRole("columnheader", { name: /モデル/ }),
	).toHaveAttribute("aria-sort", "ascending");
	expect(await scroll.evaluate((el) => el.scrollTop)).toBe(position);
	await artifact.getByRole("button", { name: "記録を更新" }).click();
	await expect(
		artifact.getByText("記録を更新しました", { exact: true }),
	).toBeVisible();
	await expect(ai.getByLabel("AIの利用を検索")).toHaveValue("fixture-model-0");
	await artifact
		.getByRole("tab", { name: "ツールチェーン", exact: true })
		.click();
	await expect(tc.getByLabel("ツールチェーンを検索")).toHaveValue(
		"固定試験の依頼 54",
	);
	await expect(
		tc.getByText("固定試験の依頼 54", { exact: true }),
	).toBeVisible();
	await tc.getByRole("button", { name: "検索を解除" }).click();
	await expect(
		tc.getByText("55件 · 1 / 6ページ", { exact: true }),
	).toBeVisible();
	await tc.getByText("保存済みの取得手順", { exact: true }).click();
	const procedures = tc.getByRole("region", { name: "取得手順", exact: true });
	const procedureTable = procedures.getByRole("table", {
		name: "取得手順",
		exact: true,
	});
	await expect(procedureTable.locator("tbody tr")).toHaveCount(10);
	await expect(
		procedures.getByText("27件 · 1 / 3ページ", { exact: true }),
	).toBeVisible();
	const original = procedureTable
		.getByRole("row")
		.filter({ hasText: "試験の取得手順" });
	await original.getByRole("button", { name: "無効にする" }).click();
	await expect(
		original.getByRole("button", { name: "有効にする" }),
	).toBeVisible();
	expect(
		(await client.toolchainRecipes()).items.find(
			(r) => r.signature === "試験の取得手順",
		)?.state,
	).toBe("disabled");
	await original.getByRole("button", { name: "有効にする" }).click();
	await expect(
		original.getByRole("button", { name: "無効にする" }),
	).toBeVisible();
	const stopped = procedureTable
		.getByRole("row")
		.filter({ hasText: "停止中の取得手順" });
	await stopped.getByRole("button", { name: "有効にする" }).click();
	await expect(
		stopped.getByRole("button", { name: "無効にする" }),
	).toBeVisible();
	await original.getByRole("button", { name: "削除", exact: true }).click();
	await tc.getByRole("button", { name: "キャンセル" }).click();
	expect((await client.toolchainRecipes()).items).toHaveLength(27);
	await original.getByRole("button", { name: "削除", exact: true }).click();
	await tc.getByRole("button", { name: "削除する" }).click();
	await expect(
		procedureTable.getByRole("row").filter({ hasText: "試験の取得手順" }),
	).toHaveCount(0);
	expect((await client.toolchainRecipes()).items).toHaveLength(26);
	await procedures.getByLabel("取得手順を検索").fill("保存手順-24");
	await procedures.getByLabel("取得手順を検索").press("Enter");
	await expect(procedureTable.locator("tbody tr")).toHaveCount(1);
	await expect(procedureTable).toContainText("保存手順-24");
	await procedures.getByRole("button", { name: "検索を解除" }).click();
	await expect(
		procedures.getByText("26件 · 1 / 3ページ", { exact: true }),
	).toBeVisible();
	await procedures
		.getByRole("columnheader", { name: /手順/ })
		.getByRole("button")
		.click();
	await expect(
		procedures.getByRole("columnheader", { name: /手順/ }),
	).toHaveAttribute("aria-sort", "ascending");
	await procedures
		.getByRole("button", { name: "取得手順の次のページ" })
		.click();
	await expect(
		procedures.getByText("26件 · 2 / 3ページ", { exact: true }),
	).toBeVisible();
	await procedures
		.getByRole("button", { name: "取得手順の次のページ" })
		.click();
	await expect(procedureTable.locator("tbody tr")).toHaveCount(6);
	for (let count = 26; count > 20; count--) {
		await procedureTable
			.getByRole("button", { name: "削除", exact: true })
			.first()
			.click();
		await tc.getByRole("button", { name: "削除する" }).click();
		await expect(
			procedures.getByText(new RegExp(`^${count - 1}件 ·`)),
		).toBeVisible();
	}
	await expect(
		procedures.getByText("20件 · 2 / 2ページ", { exact: true }),
	).toBeVisible();
	await expect(
		procedures.getByRole("button", { name: "取得手順の次のページ" }),
	).toBeDisabled();
	await artifact.getByText("データと診断", { exact: true }).click();
	const downloading = page.waitForEvent("download");
	await artifact.getByRole("button", { name: "診断データを保存" }).click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe("eumenes-diagnostics.json");
	const json = JSON.parse(readFileSync((await download.path())!, "utf8"));
	expect(json.usage).toHaveLength(100);
	expect(json.diagnostics).toBeDefined();
	expect(JSON.stringify(json)).not.toContain(token);
	expect(await client.settings()).toEqual(saved);
	expect(
		requests.some((raw) => {
			const url = new URL(raw);
			return (
				url.pathname.endsWith("selections/page") &&
				url.searchParams.get("sort") === "process" &&
				url.searchParams.get("desc") === "true" &&
				url.searchParams.get("pageIndex") === "1"
			);
		}),
	).toBe(true);
	expect(
		requests.some(
			(raw) => new URL(raw).searchParams.get("q") === "fixture-model-000",
		),
	).toBe(true);
	await artifact.getByText("データと診断", { exact: true }).click();
	await expect(tc).toBeVisible();
	await tc.getByText("保存済みの取得手順", { exact: true }).click();
	if (await tc.getByRole("button", { name: "詳細を閉じる" }).count())
		await tc.getByRole("button", { name: "詳細を閉じる" }).click();
	await page.setViewportSize({ width: 1280, height: 1000 });
	await artifact.locator(".ds-records-workspace").scrollIntoViewIfNeeded();
	await artifact.screenshot({
		path: "spec/verification/settings-records-2026-10-13/records-table-wide.png",
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await artifact.getByRole("tab", { name: "AIの利用", exact: true }).click();
	await ai.getByLabel("AIの利用の表示件数").selectOption("10");
	await expect(aiTable.locator("tbody tr")).toHaveCount(10);
	await ai.getByRole("region", { name: "AIの利用の表" }).evaluate((el) => {
		el.scrollLeft = 0;
	});
	await artifact.locator(".ds-records-workspace").scrollIntoViewIfNeeded();
	await artifact.screenshot({
		path: "spec/verification/settings-records-2026-10-13/records-table-narrow.png",
	});
	await page.reload();
	await openFromLauncher(page, "設定");
	await artifact.getByRole("button", { name: "記録", exact: true }).click();
	await expect(
		ai.getByText("125件 · 1 / 13ページ", { exact: true }),
	).toBeVisible();
	expect((await client.toolchainRecipes()).items).toHaveLength(20);
});

test("API table failures and diagnostic failures show an error and recover after explicit retry", async ({
	page,
}) => {
	let readsFail = true,
		writesFail = true,
		diagnosticsFail = false;
	await page.route("**/api/inference/usage/page?**", (route) =>
		readsFail
			? route.fulfill({ status: 503, json: { error: "fixture_failure" } })
			: route.continue(),
	);
	await page.route("**/api/toolchain-history/recipes/*/state", (route) =>
		writesFail
			? route.fulfill({ status: 503, json: { error: "fixture_failure" } })
			: route.continue(),
	);
	await page.route("**/api/settings/diagnostics", (route) =>
		diagnosticsFail
			? route.fulfill({ status: 503, json: { error: "fixture_failure" } })
			: route.continue(),
	);
	await page.goto(`http://127.0.0.1:${webPort}`);
	await openFromLauncher(page, "設定");
	const artifact = page.getByRole("complementary", {
		name: "アーティファクト",
	});
	await artifact.getByRole("button", { name: "記録", exact: true }).click();
	await expect(artifact.getByRole("alert")).toContainText(
		"利用記録を読み込めません",
	);
	readsFail = false;
	await artifact.getByRole("button", { name: "記録を更新" }).click();
	await expect(
		artifact.getByText("125件 · 1 / 13ページ", { exact: true }),
	).toBeVisible();
	await artifact
		.getByRole("tab", { name: "ツールチェーン", exact: true })
		.click();
	const tc = artifact.getByRole("tabpanel", {
		name: "ツールチェーン",
		exact: true,
	});
	await tc.getByText("保存済みの取得手順", { exact: true }).click();
	const procedures = tc.getByRole("region", { name: "取得手順", exact: true });
	await procedures.getByLabel("取得手順を検索").fill("保存手順-00");
	await procedures.getByLabel("取得手順を検索").press("Enter");
	const row = procedures.getByRole("table").locator("tbody tr");
	await expect(row).toHaveCount(1);
	await row.getByRole("button", { name: "無効にする" }).click();
	await expect(artifact.getByText(/操作に失敗しました/)).toBeVisible();
	await expect(row.getByRole("button", { name: "無効にする" })).toBeEnabled();
	writesFail = false;
	await row.getByRole("button", { name: "無効にする" }).click();
	await expect(row.getByRole("button", { name: "有効にする" })).toBeVisible();
	await artifact.getByText("データと診断", { exact: true }).click();
	diagnosticsFail = true;
	let downloads = 0;
	page.on("download", () => downloads++);
	await artifact.getByRole("button", { name: "診断データを保存" }).click();
	await expect(artifact.getByText(/操作に失敗しました/)).toBeVisible();
	expect(downloads).toBe(0);
	diagnosticsFail = false;
	const downloaded = page.waitForEvent("download");
	await artifact.getByRole("button", { name: "診断データを保存" }).click();
	await downloaded;
	expect(downloads).toBe(1);
});
