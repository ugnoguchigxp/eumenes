import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createFixture } from "./fixture";
test.setTimeout(90000);
const fixture = createFixture();
let origin: string, api: string;
test.beforeAll(async () => {
	const [apiPort, webPort] = (await fixture.ports(2)) as [number, number];
	origin = `http://127.0.0.1:${webPort}`;
	api = `http://127.0.0.1:${apiPort}`;
	await fixture.launch(
		["scripts/excalidraw-fixture-server.ts"],
		{ EUMENES_PORT: String(apiPort), EUMENES_ORIGIN: origin },
		{ ports: [apiPort] },
	);
	await fixture.ready(`${api}/api/status`);
	await fixture.launchWeb({
		webPort,
		apiPort,
		token: "fixture-token-for-toolchain-browser",
		cacheDir: `/tmp/eumenes-excalidraw-vite-${webPort}`,
	});
	await fixture.ready(origin);
});
test.afterAll(() => fixture.stopAll());
test("MacBook browser fixture: launch, edit, save, reopen, preserve failed drafts, idle and reconnect", async ({
	page,
	context,
	request,
}) => {
	const problems: string[] = [];
	page.on("pageerror", (e) => problems.push(e.message));
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(origin);
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await page
		.getByRole("menuitem", { name: "図を描く・編集する", exact: true })
		.click();
	const panel = page.getByRole("complementary", { name: "アーティファクト" });
	const accepted = page.waitForResponse(
		(r) =>
			r.request().method() === "POST" &&
			r.url().endsWith("/api/excalidraw/sessions"),
	);
	await panel.getByRole("button", { name: "新しい図", exact: true }).click();
	expect((await accepted).status()).toBe(202);
	const link = panel.getByRole("link", { name: "Excalidrawを開く" });
	await expect(link).toBeVisible();
	const url = await link.getAttribute("href");
	expect(url).toContain(`${origin}/#drawing/`);
	expect(url).not.toMatch(/18790|token|consumer|business/);
	const editor = await context.newPage();
	let gestures = 0;
	editor.on("request", (request) => {
		if (request.method() === "POST" && request.url().endsWith("/activity"))
			gestures++;
	});
	editor.on("response", async (r) => {
		if (r.url().includes("/api/excalidraw/") && r.status() >= 400)
			console.log(
				"drawing API failure",
				r.request().method(),
				new URL(r.url()).pathname,
				r.status(),
				await r.text(),
			);
	});
	editor.on("pageerror", (e) => problems.push(e.message));
	await editor.goto(url!);
	await expect(editor.getByLabel("図の名前")).toHaveValue("新しい図");
	await expect(editor.locator(".excalidraw canvas").first()).toBeVisible();
	await editor.getByLabel("図の名前").fill("ブラウザで保存した構成図");
	await expect(editor.getByRole("status").first()).toContainText(
		"保存済み（版 2）",
	);
	const canvas = editor.locator(".excalidraw canvas").first(),
		box = await canvas.boundingBox();
	await editor.mouse.click(box!.x + 120, box!.y + 120);
	await editor.keyboard.press("r");
	await editor.mouse.move(box!.x + 300, box!.y + 220);
	await editor.mouse.down();
	await editor.mouse.move(box!.x + 530, box!.y + 380);
	await editor.mouse.up();
	await expect(editor.getByRole("status").first()).toContainText(
		"保存済み（版 3）",
	);
	// URL records a particular revision; reopen latest through the saved reference.
	const latestUrl = url!.replace(/\?revision=\d+$/, "");
	await editor.goto(latestUrl);
	await expect(editor.getByLabel("図の名前")).toHaveValue(
		"ブラウザで保存した構成図",
	);
	await expect(editor.getByRole("status").first()).toContainText(
		"保存済み（版 3）",
	);
	const fail = await request.get(`${api}/fixture/save-failure?enabled=true`, {
		headers: { authorization: "Bearer fixture-token-for-toolchain-browser" },
	});
	expect(fail.ok()).toBe(true);
	await editor.getByLabel("図の名前").fill("保存失敗を保護する図");
	await expect(editor.getByRole("status").first()).toContainText("保存失敗");
	expect(
		await editor.evaluate(() =>
			Object.keys(sessionStorage).some((k) =>
				k.startsWith("eumenes-excalidraw-draft:"),
			),
		),
	).toBe(true);
	editor.on("dialog", (d) => d.accept());
	await editor.reload();
	await editor.getByRole("button", { name: "下書きを復元" }).click();
	await expect(editor.getByLabel("図の名前")).toHaveValue(
		"保存失敗を保護する図",
	);
	await request.get(`${api}/fixture/save-failure?enabled=false`, {
		headers: { authorization: "Bearer fixture-token-for-toolchain-browser" },
	});
	await editor.getByRole("button", { name: "保存", exact: true }).click();
	await expect(editor.getByRole("status").first()).toContainText(
		"保存済み（版 4）",
	);
	await expect(editor.getByRole("status").first()).toContainText(
		"無操作のため接続を解放",
		{ timeout: 10000 },
	);
	const beforeReconnect = gestures;
	await editor.getByRole("button", { name: "再接続", exact: true }).click();
	await expect(editor.getByRole("status").first()).toContainText(
		"保存済み（版 4）",
	);
	expect(gestures).toBe(beforeReconnect);
	await request.get(`${api}/fixture/restart`, {
		headers: { authorization: "Bearer fixture-token-for-toolchain-browser" },
	});
	await editor.getByLabel("図の名前").fill("再起動後の図");
	await expect(editor.getByRole("status").first()).toContainText(
		"保存済み（版 5）",
	);
	mkdirSync("spec/verification/excalidraw-2026-10-13", { recursive: true });
	await editor.screenshot({
		path: "spec/verification/excalidraw-2026-10-13/editor.png",
	});
	await page.bringToFront();
	const runHeaders = {
		authorization: "Bearer fixture-token-for-toolchain-browser",
	};
	await request.post(`${api}/api/runs`, {
		headers: runHeaders,
		data: {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "別の図を描く画面を開いて",
		},
	});
	await expect
		.poll(async () => {
			const href = await link.getAttribute("href");
			return !!href?.includes(`${origin}/#drawing/`) && href !== url;
		})
		.toBe(true);
	const next = await link.getAttribute("href");
	expect(next).toContain(`${origin}/#drawing/`);
	await request.post(`${api}/api/runs`, {
		headers: runHeaders,
		data: {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "もう一つ図の編集画面を開いて",
		},
	});
	await expect
		.poll(async () => {
			const href = await link.getAttribute("href");
			return !!href?.includes(`${origin}/#drawing/`) && href !== next;
		})
		.toBe(true);
	expect(await link.getAttribute("href")).toContain(`${origin}/#drawing/`);

	expect(problems).toEqual([]);
});
