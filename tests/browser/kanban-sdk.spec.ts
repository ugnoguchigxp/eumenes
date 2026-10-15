import { expect, test } from "@playwright/test";
import { createFixture } from "./fixture";
import { openFromLauncher } from "./artifact-launcher";
import { resolve } from "node:path";
const fixture = createFixture();
let origin: string;
let api: string;
let network: object[] = [];
test.beforeAll(async () => {
	const [apiPort, webPort] = await fixture.ports(2);
	api = `http://127.0.0.1:${apiPort}`;
	origin = `http://127.0.0.1:${webPort}`;
	await fixture.launch(
		["scripts/kanban-sdk-fixture-server.ts"],
		{
			EUMENES_PORT: String(apiPort),
			EUMENES_ORIGIN: origin,
			EUMENES_LOG_FILE: resolve(
				"verification-reports/codex-tasks-p0/sdk-browser-api.jsonl",
			),
		},
		{ ports: [apiPort!] },
	);
	await fixture.ready(`${api}/api/status`);
	await fixture.launchWeb({
		webPort: webPort!,
		apiPort: apiPort!,
		token: "fixture-token-for-toolchain-browser",
		cacheDir: `/tmp/eumenes-kanban-sdk-vite-${webPort}`,
	});
	await fixture.ready(origin);
});
test.afterAll(() => fixture.stopAll());
// Playwright requires a destructured fixture argument even when this hook uses only testInfo.
// eslint-disable-next-line no-empty-pattern
test.afterEach(async ({}, info) => {
	await info.attach("source-network", {
		body: JSON.stringify(network, null, 2),
		contentType: "application/json",
	});
	if (info.status !== info.expectedStatus)
		await info.attach("sdk-state", {
			body: JSON.stringify(
				await (await fetch(`${api}/fixture/sdk-state`)).json(),
				null,
				2,
			),
			contentType: "application/json",
		});
});
test("shared board runs Codex, shows activity, resumes its thread and keeps Claude selectable", async ({
	page,
}) => {
	network = [];
	page.on("response", async (response) => {
		const path = new URL(response.url()).pathname;
		if (path === "/api/events" || path.includes("/sources/")) {
			let board;
			if (path.includes("/sources/")) {
				try {
					const value = await response.json();
					if (Array.isArray(value.data?.cards))
						board = {
							revision: value.revision,
							cards: value.data.cards.map(
								(c: { column: string; label?: string }) => ({
									column: c.column,
									label: c.label,
								}),
							),
						};
				} catch {}
			}
			if (network.length < 200)
				network.push({
					at: Date.now(),
					path,
					status: response.status(),
					board,
				});
		}
	});
	page.on("requestfailed", (request) => {
		if (network.length < 200)
			network.push({
				at: Date.now(),
				path: new URL(request.url()).pathname,
				failed: request.failure()?.errorText,
			});
	});
	// Work, follow-up, reload, then two Git turns belong to this acceptance scenario.
	test.setTimeout(60_000);
	await page.setViewportSize({ width: 1500, height: 950 });
	await page.goto(origin);
	await openFromLauncher(page, "タスクボード");
	await page.addStyleTag({
		content:
			".timer-notifications, .timer-notifications * {pointer-events:none !important;}",
	});
	const board = page.getByRole("region", { name: "タスクボード", exact: true });
	await board.getByRole("button", { name: "タスクを追加" }).click();
	await page.getByRole("textbox", { name: "タイトル" }).fill("SDK acceptance");
	await page.getByRole("textbox", { name: "依頼内容" }).fill("fixture work");
	await page.getByRole("combobox", { name: "作業担当" }).selectOption("codex");
	const submitted = page.waitForResponse(
		(response) =>
			response.url().endsWith("/api/toolchain-actions") &&
			response.request().method() === "POST",
	);
	await page.getByRole("button", { name: "追加して実行", exact: true }).click();
	const accepted = await (await submitted).json();
	expect(accepted).toHaveProperty("status", "accepted");
	const card = board.locator("article.kanban-card").filter({
		has: page.getByRole("heading", { name: "SDK acceptance", exact: true }),
	});
	await expect(card).toContainText("Codex");
	await expect(card.locator(".kanban-label")).toHaveText("Done");
	await card.getByRole("button", { name: "詳細を見る" }).click();
	await expect(
		page.getByRole("heading", { name: "選択したタスクの活動" }),
	).toBeVisible();
	await expect(
		page.getByText("command_execution", { exact: true }).first(),
	).toBeVisible();
	await card.getByRole("button", { name: "追加で直す", exact: true }).click();
	await page
		.getByRole("textbox", { name: "追加の依頼" })
		.fill("fixture followup");
	await page.getByRole("button", { name: "送る", exact: true }).click();
	await expect
		.poll(
			async () =>
				(await (await fetch(`${api}/fixture/sdk-calls`)).json()).length,
		)
		.toBe(2);
	const calls = await (await fetch(`${api}/fixture/sdk-calls`)).json();
	expect(calls[0].threadId).toBeUndefined();
	expect(calls[1].threadId).toBeTruthy();
	await expect(card.locator(".kanban-label")).toHaveText("Done");
	await board.getByRole("button", { name: "タスクを追加" }).click();
	await expect(page.getByRole("combobox", { name: "作業担当" })).toHaveValue(
		"codex",
	);
	await page
		.getByRole("combobox", { name: "作業担当" })
		.selectOption("claude-code");
	await page.getByRole("button", { name: "キャンセル", exact: true }).click();
	await page.reload();
	await openFromLauncher(page, "タスクボード");
	await expect(card).toContainText("Codex");
	await expect(card.locator(".kanban-label")).toHaveText("Done");
	await card
		.getByRole("button", { name: "commit & push", exact: true })
		.click();
	const dialog = page.getByRole("dialog", { name: "commit & push の確認" });
	await expect(dialog).toContainText("Codex");
	await expect(dialog).toContainText("HEAD:");
	await expect(dialog.getByRole("combobox", { name: "送信先" })).toContainText(
		"origin / main",
	);
	const gitResponse = page.waitForResponse(
		(r) =>
			r.url().endsWith("/api/toolchain-actions") &&
			r.request().method() === "POST",
	);
	await dialog
		.getByRole("button", { name: "commit & push を依頼する", exact: true })
		.click();
	expect(await (await gitResponse).json()).toHaveProperty("status", "accepted");
	await expect(card).toContainText("push確認済み");
	await expect(card.locator(".kanban-label")).toHaveText("Done");
	await expect(card).not.toContainText("commit & push の報告あり");
	await page.screenshot({
		path: "verification-reports/codex-tasks-p0/sdk-board-git.png",
		fullPage: true,
	});
});

test("Codex settings can be saved twice with the refreshed revision", async ({
	page,
}) => {
	await page.goto(origin);
	await openFromLauncher(page, "Codexの作業設定");
	const enabled = page.getByRole("combobox", {
		name: "Codexでの作業を有効にする",
	});
	await expect(enabled).toHaveValue("true");
	for (const value of ["false", "true"]) {
		await enabled.selectOption(value);
		const saved = page.waitForResponse(
			(r) =>
				r.url().endsWith("/api/toolchain-actions") &&
				r.request().method() === "POST",
		);
		await page.getByRole("button", { name: "保存", exact: true }).click();
		expect(await (await saved).json()).toHaveProperty("status", "accepted");
		await expect(
			page.getByRole("button", { name: "保存", exact: true }),
		).toBeEnabled();
	}
});
