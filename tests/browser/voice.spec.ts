import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const root = process.cwd();
const processes: ChildProcess[] = [];
let dir: string;
const apiPort = 18787,
	webPort = 15173,
	larmPort = 19810;
async function ready(url: string) {
	for (let i = 0; i < 100; i++) {
		try {
			const response = await fetch(url);
			if (response.status < 500) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`server unavailable: ${url}`);
}
function launch(args: string[], env: Record<string, string> = {}) {
	const child = spawn("bun", args, {
		cwd: root,
		env: { ...process.env, ...env },
		stdio: "ignore",
	});
	processes.push(child);
	return child;
}
test.beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "eumenes-browser-"));
	launch(["scripts/larm-fixture-server.ts"], {
		LARM_FIXTURE_PORT: String(larmPort),
	});
	await ready(`http://127.0.0.1:${larmPort}/v3/agent-profiles`);
	launch(["api/application/server.ts"], {
		EUMENES_DB: join(dir, "test.sqlite3"),
		EUMENES_API_TOKEN: "fixture-api-token-123456789",
		EUMENES_PORT: String(apiPort),
		EUMENES_ORIGIN: `http://127.0.0.1:${webPort}`,
		LARM_BASE_URL: `http://127.0.0.1:${larmPort}`,
		LARM_CONTROL_TOKEN: "fixture-control",
	});
	await ready(`http://127.0.0.1:${apiPort}/api/status`);
	launch(["x", "vite", "--host", "127.0.0.1", "--port", String(webPort)], {
		EUMENES_PROXY_URL: `http://127.0.0.1:${apiPort}`,
	});
	await ready(`http://127.0.0.1:${webPort}/`);
});
test.afterAll(async () => {
	for (const child of processes) child.kill("SIGTERM");
	await new Promise((resolve) => setTimeout(resolve, 200));
	for (const child of processes)
		if (child.exitCode === null) child.kill("SIGKILL");
	rmSync(dir, { recursive: true, force: true });
});
test("text and browser audio complete through real services with fixture provider", async ({
	page,
}) => {
	await page.addInitScript(() => {
		const media = navigator.mediaDevices;
		Object.defineProperty(media, "getUserMedia", {
			configurable: true,
			value: async () => {
				const context = new AudioContext();
				const output = context.createMediaStreamDestination();
				const speak = () => {
					const oscillator = context.createOscillator();
					const gain = context.createGain();
					gain.gain.value = 0.2;
					oscillator.connect(gain);
					gain.connect(output);
					oscillator.start();
					setTimeout(() => oscillator.stop(), 550);
				};
				Reflect.set(window, "triggerSpeech", speak);
				setTimeout(speak, 400);
				return output.stream;
			},
		});
	});
	await page.goto(`http://127.0.0.1:${webPort}/`);
	await page
		.getByRole("textbox", { name: "API トークン" })
		.fill("fixture-api-token-123456789");
	await page.getByRole("button", { name: "接続" }).click();
	await page
		.getByRole("textbox", { name: "メッセージ" })
		.fill("以前の話を覚えていますか");
	await page.getByRole("button", { name: "送信" }).click();
	await expect(
		page.getByText("承知しました。先ほどの話を覚えています。").first(),
	).toBeVisible();
	const continuity = page
		.getByRole("heading", { name: "継続情報" })
		.locator("..");
	await continuity.getByRole("button", { name: "しおりを保存" }).click();
	await expect(
		continuity.locator(".bookmark-item").getByText("以前の話を覚えていますか"),
	).toBeVisible();
	const requestId = crypto.randomUUID();
	const cli = (args: string[]) =>
		spawnSync("bun", ["cli/index.ts", ...args], {
			cwd: root,
			encoding: "utf8",
			env: {
				...process.env,
				EUMENES_URL: `http://127.0.0.1:${apiPort}`,
				EUMENES_API_TOKEN: "fixture-api-token-123456789",
			},
		});
	const sent = cli([
		"send",
		"CLIからの挨拶",
		"--wait",
		"--json",
		"--request-id",
		requestId,
	]);
	expect(sent.status, sent.stderr).toBe(0);
	const sentRun = JSON.parse(sent.stdout);
	expect(sentRun.status).toBe("completed");
	const replay = cli([
		"send",
		"CLIからの挨拶",
		"--json",
		"--request-id",
		requestId,
	]);
	expect(replay.status, replay.stderr).toBe(0);
	expect(JSON.parse(replay.stdout).id).toBe(sentRun.id);
	const history = cli(["history", "main", "--json"]);
	expect(history.status, history.stderr).toBe(0);
	expect(JSON.parse(history.stdout).messages).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ text: "CLIからの挨拶" }),
		]),
	);
	await expect(
		page.locator(".messages").getByText("CLIからの挨拶"),
	).toBeVisible();
	await page.getByRole("button", { name: "音声を開始" }).click();
	try {
		await expect(page.getByText("認識: こんにちは")).toBeVisible({
			timeout: 20000,
		});
	} catch (error) {
		console.error(await page.locator("body").innerText());
		throw error;
	}
	await expect(
		page.locator(".messages").getByText("こんにちは", { exact: true }).first(),
	).toBeVisible({ timeout: 20000 });
	await expect(page.getByText("playing", { exact: true })).toBeVisible({
		timeout: 20000,
	});
	await page.evaluate(() =>
		(window as unknown as { triggerSpeech: () => void }).triggerSpeech(),
	);
	await expect(
		page.locator(".messages").getByText("こんにちは", { exact: true }),
	).toHaveCount(2, {
		timeout: 20000,
	});
	await expect(page.getByText("played", { exact: true })).toBeVisible({
		timeout: 20000,
	});
	await page.getByRole("button", { name: "停止" }).click();
	await expect(page.getByRole("button", { name: "音声を開始" })).toBeEnabled();
});
