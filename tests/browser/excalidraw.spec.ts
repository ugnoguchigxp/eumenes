import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { createFixture } from "./fixture";
test.setTimeout(90000);
test.use({ actionTimeout: 20000 });
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
	await panel.getByRole("button", { name: "図一覧", exact: true }).click();
	await panel
		.getByRole("menuitem", { name: "新しい図を作成", exact: true })
		.click();
	expect((await accepted).status()).toBe(202);
	const link = panel.locator("iframe");
	await expect(link).toBeVisible();
	const embeddedUrl = await link.getAttribute("src");
	const parsed = new URL(embeddedUrl!);
	const url = `${origin}/${parsed.hash}`;
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
	mkdirSync("spec/verification/excalidraw-artifact-2026-10-14", {
		recursive: true,
	});
	await editor.screenshot({
		path: "spec/verification/excalidraw-artifact-2026-10-14/standalone-editor.png",
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
			const href = await link.getAttribute("src");
			return (
				!!href?.includes("/excalidraw?embedded=1#drawing/") &&
				href !== embeddedUrl
			);
		})
		.toBe(true);
	const next = await link.getAttribute("src");
	expect(next).toContain("/excalidraw?embedded=1#drawing/");
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
			const href = await link.getAttribute("src");
			return (
				!!href?.includes("/excalidraw?embedded=1#drawing/") && href !== next
			);
		})
		.toBe(true);
	expect(await link.getAttribute("src")).toContain(
		"/excalidraw?embedded=1#drawing/",
	);

	expect(problems).toEqual([]);
});

test("the artifact edits in an iframe, browses thumbnails, protects unsaved work and keeps the conversation visible", async ({
	page,
	request,
}) => {
	await page.setViewportSize({ width: 1440, height: 960 });
	test.setTimeout(120000);
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto(origin);
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await page
		.getByRole("menuitem", { name: "図を描く・編集する", exact: true })
		.click();
	const panel = page.getByRole("complementary", { name: "アーティファクト" });
	const browse = () =>
		panel.getByRole("button", { name: "図一覧", exact: true }).click();
	await browse();
	await panel
		.getByRole("menuitem", { name: "新しい図を作成", exact: true })
		.click();
	const element = panel.locator("iframe");
	const frame = panel.frameLocator("iframe");
	await expect(frame.locator(".excalidraw canvas").first()).toBeVisible();
	await expect(panel.getByLabel("図の名前")).toHaveValue("新しい図");
	await expect(panel.getByRole("menu", { name: "図一覧" })).toHaveCount(0);
	const bounds = await panel.boundingBox();
	expect(bounds!.width).toBeLessThan(1440);
	expect(bounds!.x).toBeGreaterThan(0);
	const policy = await request.get(`${origin}/excalidraw?embedded=1`);
	expect(policy.headers()["content-security-policy"]).toContain(
		"frame-ancestors 'self'",
	);
	expect(policy.headers()["x-frame-options"]).toBe("SAMEORIGIN");
	await panel.getByLabel("図の名前").fill("枠内で保存した図");
	await expect(panel.getByRole("status").first()).toContainText(
		"保存済み（版 2）",
	);
	const rectangle = frame.getByRole("radio", { name: "矩形", exact: true });
	await rectangle.locator("..").click();
	await expect(rectangle).toBeChecked();
	const box = await frame.locator(".excalidraw canvas").first().boundingBox();
	await page.mouse.move(
		box!.x + box!.width * 0.35,
		box!.y + box!.height * 0.45,
	);
	await page.mouse.down();
	await page.mouse.move(box!.x + box!.width * 0.7, box!.y + box!.height * 0.65);
	await page.mouse.up();
	await expect(panel.getByRole("status").first()).toContainText(
		"保存済み（版 3）",
	);
	const savedUrl = await element.getAttribute("src");
	await browse();
	await expect(
		panel.getByRole("menuitem", { name: "枠内で保存した図" }).locator("img"),
	).toBeVisible();
	await panel
		.getByRole("menuitem", { name: "新しい図を作成", exact: true })
		.click();
	await expect(panel.getByLabel("図の名前")).toHaveValue("新しい図");
	await browse();
	await panel.getByRole("menuitem", { name: "枠内で保存した図" }).click();
	await expect(panel.getByLabel("図の名前")).toHaveValue("枠内で保存した図");
	await expect(panel.getByRole("status").first()).toContainText(
		"保存済み（版 3）",
	);
	const currentFrame = page
		.frames()
		.find(
			(f) =>
				f.parentFrame() === page.mainFrame() && f.url().includes("/excalidraw"),
		)!;
	const reloaded = page.waitForResponse(
		(r) =>
			r.ok() &&
			r.request().method() === "GET" &&
			new URL(r.url()).pathname.endsWith("/document"),
	);
	await currentFrame.evaluate(() => window.location.reload());
	const document = await (await reloaded).json();
	expect(document.revision).toBe(3);
	await expect(frame.locator(".excalidraw canvas").first()).toBeVisible();
	await expect(panel.getByLabel("図の名前")).toHaveValue("枠内で保存した図");
	await expect(panel.getByRole("status").first()).toContainText(
		"保存済み（版 3）",
	);
	if (await page.evaluate(() => document.fullscreenEnabled)) {
		const before = await element.getAttribute("src");
		await panel.getByRole("button", { name: "全画面で編集" }).click();
		await expect
			.poll(() => page.evaluate(() => !!document.fullscreenElement))
			.toBe(true);
		await panel.getByRole("button", { name: "全画面を終了" }).click();
		await expect
			.poll(() => page.evaluate(() => !!document.fullscreenElement))
			.toBe(false);
		expect(await element.getAttribute("src")).toBe(before);
	}
	const headers = {
		authorization: "Bearer fixture-token-for-toolchain-browser",
	};
	await request.get(`${api}/fixture/save-failure?enabled=true`, { headers });
	await panel.getByLabel("図の名前").fill("失敗中の編集を保持");
	await expect(panel.getByRole("status").first()).toContainText("保存失敗");
	const protectedUrl = await element.getAttribute("src");
	await browse();
	await panel
		.getByRole("menuitem", { name: "新しい図を作成", exact: true })
		.click();
	await expect(panel.getByRole("alert")).toContainText("未保存");
	expect(await element.getAttribute("src")).toBe(protectedUrl);
	await panel.getByRole("button", { name: "図一覧を閉じる" }).first().click();
	await panel
		.getByRole("button", { name: "図を描く・編集するを閉じる", exact: true })
		.click();
	await expect(element).toBeVisible();
	await request.get(`${api}/fixture/save-failure?enabled=false`, { headers });
	await panel.getByRole("button", { name: "保存", exact: true }).click();
	await expect(panel.getByRole("status").first()).toContainText(
		"保存済み（版 4）",
	);
	await expect(panel.getByRole("status").first()).toContainText(
		"無操作のため接続を解放",
		{ timeout: 10000 },
	);
	await panel.getByRole("button", { name: "再接続", exact: true }).click();
	await expect(panel.getByRole("status").first()).toContainText(
		"保存済み（版 4）",
	);
	await request.get(`${api}/fixture/restart`, { headers });
	await panel.getByLabel("図の名前").fill("枠内の再起動後");
	await expect(panel.getByRole("status").first()).toContainText(
		"保存済み（版 5）",
	);
	expect(savedUrl).not.toMatch(/token|consumer|18790/);
	await page.screenshot({ path: "/tmp/eumenes-excalidraw-artifact.png" });
	await panel
		.getByRole("button", { name: "図を描く・編集するを閉じる", exact: true })
		.click();
	await expect(element).toHaveCount(0);
	expect(errors).toEqual([]);
});
