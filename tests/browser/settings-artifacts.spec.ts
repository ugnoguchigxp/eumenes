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
		artifact.getByRole("button", { name: /音声と入力/ }),
	).toBeDisabled();
	await expect(
		artifact.getByRole("button", { name: /予約|委任した作業|プロジェクト/ }),
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
