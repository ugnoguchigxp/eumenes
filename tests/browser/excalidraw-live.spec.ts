import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
const execute = promisify(execFile);
const enabled = process.env.EUMENES_EXCALIDRAW_LIVE === "1";
const origin =
	process.env.EUMENES_EXCALIDRAW_WEB_ORIGIN || "http://127.0.0.1:5173";
const serviceHost = process.env.EUMENES_EXCALIDRAW_SSH_HOST || "gnosis";
test.skip(
	!enabled,
	"Explicitly enable only after formal LARM consumer and Eumenes connection setup.",
);
test.setTimeout(600000);
test.use({ actionTimeout: 20000 });
async function workerPid() {
	const result = await execute(
		"ssh",
		[
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=5",
			serviceHost,
			"systemctl show larm-local-service-excalidraw-app.service --property=MainPID --value",
		],
		{ timeout: 10000, maxBuffer: 1024 },
	);
	const value = Number(result.stdout.trim());
	if (!Number.isSafeInteger(value) || value < 0)
		throw new Error("invalid_worker_observation");
	return value;
}
test("formal connection: cold start, MacBook drawing/save/reopen, physical idle stop and next-ensure recovery", async ({
	page,
	context,
}) => {
	// Do not force-stop a worker or disturb a different consumer to manufacture cold state.
	expect(
		await workerPid(),
		"Wait for other consumers to release their leases before cold acceptance",
	).toBe(0);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(origin);
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await page
		.getByRole("menuitem", { name: "図を描く・編集する", exact: true })
		.click();
	const panel = page.getByRole("complementary", { name: "アーティファクト" });
	await panel.getByRole("button", { name: "図一覧", exact: true }).click();
	await panel
		.getByRole("menuitem", { name: "新しい図を作成", exact: true })
		.click();
	const link = panel.locator("iframe");
	await expect(link).toBeVisible({ timeout: 180000 });
	const embedded = new URL((await link.getAttribute("src"))!);
	const url = `${origin}/${embedded.hash}`;
	expect(new URL(url).origin).toBe(new URL(origin).origin);
	expect(url).not.toMatch(/token|consumer|127\.0\.0\.1:1879/);
	const startedPid = await workerPid();
	expect(startedPid).toBeGreaterThan(0);
	const editor = await context.newPage();
	editor.on("pageerror", (error) => errors.push(error.message));
	await editor.setViewportSize({ width: 1440, height: 1000 });
	await editor.goto(url);
	await expect(editor.locator(".excalidraw canvas").first()).toBeVisible({
		timeout: 180000,
	});
	const title = `Eumenes実接続受入 ${new Date().toISOString()}`;
	await editor.getByLabel("図の名前").fill(title);
	await expect(editor.getByRole("status").first()).toContainText(
		"保存済み（版 2）",
	);
	const canvas = editor.locator(".excalidraw canvas").first();
	const box = (await canvas.boundingBox())!;
	await editor.mouse.click(box.x + 120, box.y + 120);
	await editor.keyboard.press("r");
	await editor.mouse.move(box.x + 300, box.y + 220);
	await editor.mouse.down();
	await editor.mouse.move(box.x + 530, box.y + 380);
	await editor.mouse.up();
	await expect(editor.getByRole("status").first()).toContainText(
		"保存済み（版 3）",
	);
	let loaded: { revision: number; count: number } | undefined;
	const observedDocument = () => loaded;
	editor.on("response", async (response) => {
		if (
			response.request().method() === "GET" &&
			response.url().endsWith("/document") &&
			response.ok()
		) {
			const data = await response.json();
			loaded = { revision: data.revision, count: data.scene.elements.length };
		}
	});
	const latestUrl = url.replace(/\?revision=\d+$/, "");
	await editor.goto(latestUrl);
	await expect(editor.getByLabel("図の名前")).toHaveValue(title);
	await expect.poll(() => loaded).toEqual({ revision: 3, count: 1 });
	await expect(editor.getByRole("status").first()).toContainText(
		"無操作のため接続を解放",
		{ timeout: 45000 },
	);
	await expect.poll(workerPid, { timeout: 360000, intervals: [5000] }).toBe(0);
	loaded = undefined;
	await editor.getByRole("button", { name: "再接続", exact: true }).click();
	await expect(editor.getByLabel("図の名前")).toHaveValue(title, {
		timeout: 180000,
	});
	await expect.poll(() => loaded).toEqual({ revision: 3, count: 1 });
	const restartedPid = await workerPid();
	expect(restartedPid).toBeGreaterThan(0);
	expect(restartedPid).not.toBe(startedPid);
	await editor
		.getByRole("radio", { name: /矩形/ })
		.locator("..")
		.click();
	await editor.mouse.move(box.x + 600, box.y + 420);
	await editor.mouse.down();
	await editor.mouse.move(box.x + 760, box.y + 550);
	await editor.mouse.up();
	await expect(editor.getByRole("status").first()).toContainText(
		"保存済み（版 4）",
	);
	loaded = undefined;
	await editor.goto(latestUrl);
	await expect(editor.getByLabel("図の名前")).toHaveValue(title);
	await expect.poll(() => loaded).toEqual({ revision: 4, count: 2 });
	expect(errors).toEqual([]);
	const directory = "spec/verification/excalidraw-live";
	mkdirSync(directory, { recursive: true });
	await editor.screenshot({ path: `${directory}/editor.png` });
	writeFileSync(
		`${directory}/browser.json`,
		JSON.stringify(
			{
				checkedAt: new Date().toISOString(),
				mode: "formal-live",
				url: latestUrl,
				revision: observedDocument()?.revision,
				sceneElements: observedDocument()?.count,
				startedPid,
				restartedPid,
				physicalIdleStop: true,
				browserEdited: true,
				saveAndReopen: true,
				workerRestartRecovered: true,
				reconnectEditedSavedReopened: true,
				backendRestartRecovered: "not_checked",
				realLlmRouting: "not_checked",
			},
			null,
			2,
		),
	);
	// Close this test's sessions; retain the explicitly created acceptance drawing as evidence.
	await editor.getByRole("button", { name: "閉じる", exact: true }).click();
});

test("formal artifact iframe: MacBook edit, LARM save, thumbnail, reopen and idle reconnect", async ({
	page,
}) => {
	test.setTimeout(150000);
	await page.setViewportSize({ width: 1440, height: 960 });
	const errors: string[] = [];
	const documents: Array<{ revision: number; count: number }> = [];
	page.on("pageerror", (e) => errors.push(e.message));
	page.on("response", async (r) => {
		if (
			r.ok() &&
			r.request().method() === "GET" &&
			new URL(r.url()).pathname.endsWith("/document")
		) {
			const d = await r.json();
			documents.push({ revision: d.revision, count: d.scene.elements.length });
		}
	});
	await page.goto(origin);
	await page.getByRole("button", { name: "アーティファクトを開く" }).click();
	await page
		.getByRole("menuitem", { name: "図を描く・編集する", exact: true })
		.click();
	const panel = page.getByRole("complementary", { name: "アーティファクト" });
	await panel.getByRole("button", { name: "図一覧", exact: true }).click();
	await panel
		.getByRole("menuitem", { name: "新しい図を作成", exact: true })
		.click();
	const iframe = panel.locator("iframe");
	const frame = panel.frameLocator("iframe");
	await expect(frame.locator(".excalidraw canvas").first()).toBeVisible({
		timeout: 60000,
	});
	const title = `Artifact埋め込み受入 ${new Date().toISOString()}`;
	await panel.getByLabel("図の名前").fill(title);
	await expect(panel.getByRole("status").first()).toContainText(
		"保存済み（版 2）",
	);
	await frame
		.getByRole("radio", { name: "矩形", exact: true })
		.locator("..")
		.click();
	const box = (await frame
		.locator(".excalidraw canvas")
		.first()
		.boundingBox())!;
	await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.45);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.65);
	await page.mouse.up();
	await expect(panel.getByRole("status").first()).toContainText(
		"保存済み（版 3）",
	);
	const url = (await iframe.getAttribute("src"))!;
	expect(new URL(url).origin).toBe(new URL(origin).origin);
	expect(url).not.toMatch(/token|consumer|18790/);
	await panel.getByRole("button", { name: "図一覧", exact: true }).click();
	const item = panel.getByRole("menuitem", { name: title, exact: true });
	await expect(item.locator("img")).toBeVisible();
	const directory = "spec/verification/excalidraw-live";
	mkdirSync(directory, { recursive: true });
	await panel.screenshot({ path: `${directory}/artifact-menu-2026-10-14.png` });
	await item.click();
	await expect(panel.getByRole("menu", { name: "図一覧" })).toHaveCount(0);
	const child = page
		.frames()
		.find(
			(f) =>
				f.parentFrame() === page.mainFrame() && f.url().includes("/excalidraw"),
		)!;
	documents.length = 0;
	await child.evaluate(() => window.location.reload());
	await expect.poll(() => documents.at(-1)).toEqual({ revision: 3, count: 1 });
	await expect(panel.getByLabel("図の名前")).toHaveValue(title);
	await expect(panel.getByRole("status").first()).toContainText(
		"無操作のため接続を解放",
		{ timeout: 45000 },
	);
	documents.length = 0;
	await panel.getByRole("button", { name: "再接続", exact: true }).click();
	await expect.poll(() => documents.at(-1)).toEqual({ revision: 3, count: 1 });
	await expect(panel.getByRole("status").first()).toContainText(
		"保存済み（版 3）",
	);
	await panel.screenshot({ path: `${directory}/artifact-2026-10-14.png` });
	expect(errors).toEqual([]);
	writeFileSync(
		`${directory}/artifact-2026-10-14.json`,
		JSON.stringify(
			{
				checkedAt: new Date().toISOString(),
				mode: "formal-live-artifact-iframe",
				initialFrameUrl: url,
				reopenedFrameUrl: child.url(),
				revision: 3,
				sceneElements: 1,
				browserEdited: true,
				larmSaveAndReopen: true,
				thumbnail: true,
				artifactIdleReleaseAndReconnect: true,
				physicalWorkerStop: "previous_acceptance_only",
				backendRestart: "fixture_only_this_change",
				pageErrors: errors,
			},
			null,
			2,
		),
	);
	await panel
		.getByRole("button", { name: "図を描く・編集するを閉じる", exact: true })
		.click();
	await expect(iframe).toHaveCount(0);
});
