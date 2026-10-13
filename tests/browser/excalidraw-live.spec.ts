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
	await panel.getByRole("button", { name: "新しい図", exact: true }).click();
	const link = panel.getByRole("link", { name: "Excalidrawを開く" });
	await expect(link).toBeVisible({ timeout: 180000 });
	const url = (await link.getAttribute("href"))!;
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
	await editor.reload();
	await expect(editor.getByLabel("図の名前")).toHaveValue(title, {
		timeout: 180000,
	});
	await expect.poll(() => loaded).toEqual({ revision: 3, count: 1 });
	const restartedPid = await workerPid();
	expect(restartedPid).toBeGreaterThan(0);
	expect(restartedPid).not.toBe(startedPid);
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
