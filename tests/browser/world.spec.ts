import { test, expect, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture } from "./fixture";

/**
 * P5-02 / A48 in a browser, against the hermetic World fixture backend
 * (temp-file store, production migrations, the real World assembly, stub
 * model, no network). It is NOT the product database and not a real model.
 */
const TOKEN = "fixture-token-for-world-browser";
test.setTimeout(180000);
test.describe.configure({ mode: "serial" });
let apiPort: number;
let webPort: number;
let dir: string;
const fixture = createFixture();
let api: ChildProcess | undefined;

async function startApi(stall: boolean) {
	return fixture.launch(
		["scripts/world-fixture-server.ts"],
		{
			EUMENES_PORT: String(apiPort),
			EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
			WORLD_FIXTURE_DIR: dir,
			WORLD_FIXTURE_STALL: stall ? "1" : "0",
			WORLD_FIXTURE_POLL_MS: "1000",
		},
		{ ports: [apiPort] },
	);
}
const waitApi = () =>
	fixture.waitUntil(
		async () =>
			(
				await fetch(`http://127.0.0.1:${apiPort}/api/world/status`, {
					headers: { authorization: `Bearer ${TOKEN}` },
				})
			).ok,
		{ attempts: 150, message: "fixture_not_ready" },
	);
const call = (path: string, init: RequestInit = {}) =>
	fetch(`http://127.0.0.1:${apiPort}${path}`, {
		...init,
		headers: {
			authorization: `Bearer ${TOKEN}`,
			"content-type": "application/json",
			origin: `http://127.0.0.1:${webPort}`,
		},
	});

test.beforeAll(async () => {
	apiPort = await fixture.port();
	webPort = await fixture.port();
	dir = mkdtempSync(join(tmpdir(), "eumenes-world-browser-"));
	api = await startApi(true);
	await fixture.launchWeb({
		webPort,
		apiPort,
		token: TOKEN,
		cacheDir: `/tmp/eumenes-world-vite-${webPort}`,
	});
	await waitApi();
	await fixture.waitUntil(
		async () => (await fetch(`http://127.0.0.1:${webPort}`)).ok,
		{ attempts: 150, message: "web_not_ready" },
	);
});
test.afterAll(async () => {
	await fixture.stopAll();
	rmSync(dir, { recursive: true, force: true });
});

async function openWorld(page: Page) {
	await page.goto(`http://127.0.0.1:${webPort}`);
	await page.getByRole("button", { name: "設定", exact: true }).click();
	await page.getByRole("button", { name: "World", exact: true }).click();
}

test("the list separates the axes and never styles hypothesis or measurement as confirmed; conflict, retract and forget behave honestly; a restart finishes the forget", async ({
	page,
}, info) => {
	const audio: string[] = [];
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (path.startsWith("/api/") && /audio|voice|replay|speak/i.test(path))
			audio.push(path);
	});
	await openWorld(page);
	const table = page.getByRole("table");
	await expect(table).toBeVisible({ timeout: 30000 });
	await expect(
		table
			.getByRole("columnheader")
			.filter({ hasText: /^(対象|主張|採用状態|根拠の種類|鮮度)$/ }),
	).toHaveCount(5);
	const line = (predicate: string) =>
		table.getByRole("row").filter({ hasText: predicate });
	await expect(line("launch_month")).toContainText("仮説（採用しても未確認）");
	await expect(line("latency")).toContainText("実測（採用済み）");
	await expect(line("price")).toContainText("候補（未採用）");
	await expect(line("available")).not.toContainText("仮説");
	await expect(line("available")).not.toContainText("実測");
	await expect(line("available")).not.toContainText("候補");
	await page.screenshot({
		path: info.outputPath("world-list.png"),
		fullPage: true,
	});

	// Detail: conditions, support, refutations, source versions, history.
	await line("available")
		.getByRole("button", { name: /詳細/ })
		.click();
	const drawer = page.getByRole("dialog");
	await expect(drawer.getByText("観測がそろうまで未確認")).toBeVisible();
	await expect(
		drawer.getByRole("region", { name: "支持する根拠" }),
	).toContainText("本人の発言");
	await expect(drawer.getByRole("region", { name: "出典の版" })).toContainText(
		"現在の版",
	);
	await expect(drawer.getByRole("region", { name: "履歴" })).toBeVisible();
	await page.screenshot({
		path: info.outputPath("world-detail.png"),
		fullPage: true,
	});

	// Conflict: the page keeps showing an OLD revision (stale responses), the
	// ledger moves on, and the submit is refused with a reload hint.
	const stale = new Map<string, string>();
	for (const path of ["/api/world/claims/claim-report", "/api/world/claims"]) {
		const res = await call(path);
		stale.set(path, await res.text());
	}
	await page.route(
		/\/api\/world\/claims(\/claim-report)?(\?.*)?$/,
		async (route) => {
			if (route.request().method() !== "GET") return route.continue();
			const path = new URL(route.request().url()).pathname;
			const body = stale.get(path);
			return body
				? route.fulfill({ status: 200, contentType: "application/json", body })
				: route.continue();
		},
	);
	const bumped = await call("/api/world/claims/correct", {
		method: "POST",
		body: JSON.stringify({
			requestId: crypto.randomUUID(),
			expectedRevision: 2,
			target: { claimId: "claim-report" },
			reasonMessageId: "m2",
			value: { kind: "boolean", value: false },
		}),
	});
	expect(bumped.status).toBe(200);
	await drawer.getByRole("button", { name: "撤回する" }).click();
	await drawer
		.getByLabel("理由にする、あなたの発言")
		.selectOption({ label: "いいえ、音声サービスは10月からです。" });
	await drawer.getByRole("button", { name: "撤回を送る" }).click();
	await expect(drawer.getByRole("alert")).toContainText(
		"他の操作で変わりました",
	);
	await expect(drawer.getByRole("alert")).toContainText(
		"最新の内容を読み込みました",
	);
	await expect(page.getByText(/撤回しました/)).toHaveCount(0);
	await page.screenshot({
		path: info.outputPath("world-conflict.png"),
		fullPage: true,
	});
	await page.unroute(/\/api\/world\/claims(\/claim-report)?(\?.*)?$/);
	await drawer.getByRole("button", { name: "閉じる" }).click();

	// Retract the candidate with the person's own statement as the reason.
	await line("price")
		.getByRole("button", { name: /詳細/ })
		.click();
	await drawer.getByRole("button", { name: "撤回する" }).click();
	await drawer.getByLabel("理由にする、あなたの発言").selectOption("m2");
	await drawer.getByRole("button", { name: "撤回を送る" }).click();
	await expect(page.getByText(/撤回しました/)).toBeVisible();
	await expect(line("price")).toHaveCount(0);

	// Forget: accepted, never "done" while it is unfinished.
	await line("latency")
		.getByRole("button", { name: /詳細/ })
		.click();
	await drawer.getByRole("button", { name: "忘れる" }).click();
	await drawer.getByRole("checkbox").check();
	await drawer.getByRole("button", { name: "忘れる手続きを始める" }).click();
	const forgets = page.getByRole("region", { name: "忘却の状況" });
	await expect(forgets).toContainText(
		"外部の削除の確認待ち（完了ではありません）",
	);
	await expect(
		page.getByText(/忘却を受け付けました。完了ではありません/),
	).toBeVisible();
	await expect(forgets.getByRole("listitem")).not.toHaveText(/^完了/);
	await page.screenshot({
		path: info.outputPath("world-forget-pending.png"),
		fullPage: true,
	});

	// Restart the backend on the same database (without the stall): the unfinished
	// forget is picked up again and only then reads as complete.
	await fixture.stop(api);
	api = await startApi(false);
	await waitApi();
	await page.reload();
	// The settings hash survives the reload; only the category is back to its default.
	await page.getByRole("button", { name: "World", exact: true }).click();
	await expect(
		page.getByRole("region", { name: "忘却の状況" }).getByRole("listitem"),
	).toHaveText(/^完了/, { timeout: 30000 });
	await expect(page.getByRole("table")).toBeVisible();
	await expect(page.getByRole("table")).not.toContainText("latency");
	await page.screenshot({
		path: info.outputPath("world-forget-complete.png"),
		fullPage: true,
	});
	// This screen is never read aloud: nothing asked the audio endpoints.
	expect(audio).toEqual([]);
});
