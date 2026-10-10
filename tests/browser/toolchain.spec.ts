import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
async function port() {
	const s = createServer();
	await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
	const p = (s.address() as AddressInfo).port;
	await new Promise<void>((r) => s.close(() => r()));
	return p;
}
test.setTimeout(60000);
let apiPort: number, webPort: number;
const processes: ChildProcess[] = [];
test.beforeAll(async () => {
	apiPort = await port();
	webPort = await port();
	const api = spawn(
		process.execPath.includes("node") ? "bun" : process.execPath,
		["scripts/toolchain-fixture-server.ts"],
		{
			env: {
				...process.env,
				EUMENES_PORT: String(apiPort),
				EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
			},
			stdio: "ignore",
		},
	);
	processes.push(api);
	const web = spawn("bun", ["run", "dev:web", "--port", String(webPort)], {
		env: {
			...process.env,
			EUMENES_PROXY_URL: `http://127.0.0.1:${apiPort}`,
			EUMENES_API_TOKEN: "fixture-token-for-toolchain-browser",
			EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
			EUMENES_VITE_CACHE_DIR: `/tmp/eumenes-toolchain-vite-${webPort}`,
			LARM_API_TOKEN: "",
		},
		stdio: "ignore",
	});
	processes.push(web);
	for (let i = 0; i < 100; i++) {
		try {
			const r = await fetch(`http://127.0.0.1:${webPort}`);
			if (r.ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error("fixture_not_ready");
});
test.afterAll(async () => {
	for (const p of processes) p.kill("SIGTERM");
	await new Promise((r) => setTimeout(r, 200));
	for (const p of processes) if (p.exitCode === null) p.kill("SIGKILL");
});
for (const [question, answer] of [
	["東京の天気を調べて", "26度"],
	["AAPLの株価を調べて", "250.12"],
])
	test(`browser → API → child → web → summary → main: ${question}`, async ({
		page,
	}) => {
		await page.goto(`http://127.0.0.1:${webPort}`);
		await expect(page.getByText(/接続済み/)).toBeVisible({ timeout: 20000 });
		await page.getByRole("textbox").fill(question!);
		const submission = page.waitForResponse(
			(r) => r.url().endsWith("/api/runs") && r.request().method() === "POST",
		);
		await page.getByRole("button", { name: "送信", exact: true }).click();
		const response = await submission;
		expect(response.status()).toBe(202);
		const body = await response.json();
		expect(body.agentTaskId).toBeTruthy();
		await expect(page.getByRole("textbox")).toHaveValue("");
		const card = page.getByRole("complementary", { name: `調査: ${question}` });
		await expect(card).toBeVisible({ timeout: 20000 });
		await expect(page.locator(".message .research-activity")).toHaveCount(0);
		await expect(card.locator(".message-author")).toHaveCount(0);
		await expect(card).not.toContainText(question!);
		await expect(card.locator("details")).toHaveAttribute("open", "");
		await expect(card).toContainText(answer!, { timeout: 20000 });
		await expect(card.getByRole("link", { name: "一次資料" })).toHaveAttribute(
			"href",
			/https:\/\/example.com\//,
		);
		await expect(page.locator(".message-assistant").last()).toContainText(
			answer!,
		);

		const answerBubble = page.locator(".message-assistant").last();
		const sourceLink = answerBubble.getByRole("link", { name: "example.com" });
		await expect(sourceLink).toHaveAttribute("target", "_blank");
		await expect(sourceLink).toHaveAttribute("href", /https:\/\/example.com\//);
		if (question === "東京の天気を調べて") {
			await expect(answerBubble).toContainText("最低17度");
			await expect(answerBubble).toContainText("降水確率0％");
		}
		await expect(page.locator("body")).not.toContainText("INJECTION_SENTINEL");
		await page.reload();
		await expect(page.getByText(/接続済み/)).toBeVisible({ timeout: 20000 });
		await expect(card).toContainText(answer!, { timeout: 20000 });
		await expect(card.locator("details")).toHaveAttribute("open", "");
		if (question === "東京の天気を調べて") {
			await page.screenshot({
				path: "spec/verification/research-activity/desktop.png",
			});
			await page.setViewportSize({ width: 390, height: 844 });
			await expect(card).toBeVisible();
			expect(
				await card.evaluate((el) => el.getBoundingClientRect().right),
			).toBeLessThanOrEqual(390);
			await page.screenshot({
				path: "spec/verification/research-activity/mobile.png",
			});
		}
	});
