import {
	test,
	expect,
	type BrowserContext,
	type FrameLocator,
} from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync } from "node:fs";

type HttpResult = {
	status: number;
	headers: Record<string, string>;
	body: string;
};
class CanvasFixture {
	private child: ChildProcessWithoutNullStreams;
	private sequence = 0;
	private pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	private ready = Promise.withResolvers<{
		hostOrigin: string;
		previewOrigin: string;
	}>();
	constructor() {
		this.child = spawn("bun", ["scripts/canvas-browser-fixture.ts"], {
			cwd: process.cwd(),
			stdio: "pipe",
			env: { ...process.env, NODE_ENV: "test" },
		});
		this.child.stderr.on("data", (chunk) => process.stderr.write(chunk));
		createInterface({ input: this.child.stdout }).on("line", (line) => {
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				return;
			}
			if (message.ready) this.ready.resolve(message);
			const waiting = this.pending.get(message.id);
			if (!waiting) return;
			this.pending.delete(message.id);
			if (message.error) waiting.reject(new Error(message.error));
			else waiting.resolve(message.result);
		});
		this.child.once("error", (error) => this.ready.reject(error));
		this.child.once("exit", (code) => {
			const error = new Error(`Canvas fixture exited (${code})`);
			this.ready.reject(error);
			for (const waiting of this.pending.values()) waiting.reject(error);
		});
	}
	start() {
		return this.ready.promise;
	}
	call<T = unknown>(
		op: string,
		input: Record<string, unknown> = {},
	): Promise<T> {
		const id = ++this.sequence;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
			this.child.stdin.write(JSON.stringify({ id, op, ...input }) + "\n");
		});
	}
	async route(context: BrowserContext) {
		await context.route("**/*", async (route) => {
			const request = route.request();
			const result = await this.call<HttpResult>("http", {
				url: request.url(),
				method: request.method(),
				headers: await request.allHeaders(),
				body: request.postData() ?? undefined,
			});
			await route.fulfill({
				status: result.status,
				headers: result.headers,
				body: Buffer.from(result.body, "base64"),
			});
		});
	}
	async close() {
		if (this.child.exitCode !== null) return;
		const ended = new Promise<void>((resolve) =>
			this.child.once("exit", () => resolve()),
		);
		this.child.stdin.end(
			JSON.stringify({ id: ++this.sequence, op: "close" }) + "\n",
		);
		await ended;
	}
}

const browserEnv = Object.fromEntries(
	["HOME", "USER", "PATH", "TMPDIR", "LANG", "LC_ALL"].flatMap((key) =>
		process.env[key] === undefined ? [] : [[key, process.env[key]!]],
	),
);
test.use({ launchOptions: { args: ["--mute-audio"], env: browserEnv } });
test.setTimeout(90_000);
let fixture: CanvasFixture;
let host: string;
test.beforeAll(async () => {
	fixture = new CanvasFixture();
	host = (await fixture.start()).hostOrigin;
});
test.beforeEach(async ({ context }) => {
	await fixture.route(context);
});
test.afterAll(async () => {
	await fixture?.close();
});

async function ready(workbench: FrameLocator) {
	await expect(workbench.locator("body")).toHaveAttribute("data-ready", "1");
}
async function make(workbench: FrameLocator, message: string) {
	await workbench
		.getByRole("button", { name: "Canvasの会話", exact: true })
		.click();
	await workbench.locator("#message").fill(message);
	await workbench.locator("#send").click();
	await expect(workbench.locator("#candidate")).toBeVisible();
	await workbench
		.getByRole("button", { name: "Canvasの会話を閉じる", exact: true })
		.click();
}

test("Artifactで制作・実際のキー操作・保存・再表示・復元を行う", async ({
	page,
}) => {
	await page.goto(host + "/?conversationId=browser-save");
	const workbench = page.frameLocator('iframe[title="Canvasアプリ"]');
	await ready(workbench);
	await make(workbench, "操作する青い四角形");
	const canvas = workbench
		.locator("#preview-frame")
		.frameLocator("iframe")
		.locator("canvas");
	await expect(canvas).toBeVisible();
	await canvas.click({ position: { x: 120, y: 100 } });
	const before = await canvas.screenshot();
	await page.keyboard.press("ArrowRight");
	await expect
		.poll(async () => !(await canvas.screenshot()).equals(before))
		.toBe(true);
	await workbench.locator("#save").click();
	await expect(workbench.locator("#save-status")).toContainText("r1");
	await workbench
		.getByRole("button", { name: "ブラウザいっぱい", exact: true })
		.click();
	await expect(page.locator('iframe[title="Canvasアプリ"]')).toHaveClass(
		/canvas-workbench-expanded/,
	);
	await workbench
		.getByRole("button", { name: "Artifact表示に戻る", exact: true })
		.click();
	await expect(page.locator('iframe[title="Canvasアプリ"]')).not.toHaveClass(
		/canvas-workbench-expanded/,
	);
	await workbench.getByRole("button", { name: "全画面", exact: true }).click();
	await expect
		.poll(() =>
			workbench
				.locator("body")
				.evaluate(() => document.fullscreenElement !== null),
		)
		.toBe(true);
	await workbench
		.getByRole("button", { name: "Artifact表示に戻る", exact: true })
		.click();
	await expect
		.poll(() =>
			workbench
				.locator("body")
				.evaluate(() => document.fullscreenElement === null),
		)
		.toBe(true);
	await make(workbench, "四角形の修正候補");
	await workbench.locator("#save").click();
	await expect(workbench.locator("#save-status")).toContainText("r2");
	await page.reload();
	await ready(workbench);
	await workbench
		.getByRole("button", { name: "作品一覧と版履歴", exact: true })
		.click();
	await workbench
		.locator("#artworks button")
		.filter({ hasText: "四角形の修正候補" })
		.click();
	await expect(workbench.locator("#current")).toContainText("r2");
	await workbench
		.locator('#revisions li[data-revision="1"]')
		.getByRole("button", { name: "この版を復元" })
		.click();
	await expect(workbench.locator("#restore-status")).toContainText("r1 を r3");
	mkdirSync("test-results/canvas-app", { recursive: true });
	await page.screenshot({ path: "test-results/canvas-app/restored.png" });
});

test("失敗した後に初めて画面を開いても制作失敗を表示する", async ({ page }) => {
	await fixture.call("failure", { conversationId: "browser-failure" });
	await page.goto(host + "/?conversationId=browser-failure");
	const workbench = page.frameLocator('iframe[title="Canvasアプリ"]');
	await ready(workbench);
	await expect(workbench.locator("#run-status")).toContainText(
		"完了できませんでした",
	);
	await expect(workbench.locator("#candidate")).toBeHidden();
});

test("古いrunの取得中に送った新しい依頼を、古い候補で上書きしない", async ({
	page,
}) => {
	const old = await fixture.call<{ runId: string }>("complete", {
		conversationId: "browser-pending",
	});
	const oldStarted = Promise.withResolvers<void>();
	const releaseOld = Promise.withResolvers<void>();
	const newStarted = Promise.withResolvers<void>();
	const releaseNew = Promise.withResolvers<void>();
	const nextCycle = Promise.withResolvers<void>();
	let polls = 0;
	await page.route("**/api/canvas/jobs/latest?**", async (route) => {
		if (++polls >= 2) nextCycle.resolve();
		await route.fallback();
	});
	await page.route("**/api/canvas/runs/" + old.runId, async (route) => {
		oldStarted.resolve();
		await releaseOld.promise;
		await route.fallback();
	});
	await page.route("**/api/canvas/runs", async (route) => {
		if (route.request().method() === "POST") {
			newStarted.resolve();
			await releaseNew.promise;
		}
		await route.fallback();
	});
	try {
		await page.goto(host + "/?conversationId=browser-pending");
		const workbench = page.frameLocator('iframe[title="Canvasアプリ"]');
		await ready(workbench);
		await oldStarted.promise;
		await workbench
			.getByRole("button", { name: "Canvasの会話", exact: true })
			.click();
		await workbench.locator("#message").fill("新しい依頼の候補");
		await workbench.locator("#send").click();
		await newStarted.promise;
		releaseOld.resolve();
		// The next polling cycle starts only after the previous read has returned.
		await nextCycle.promise;
		releaseNew.resolve();
		await expect(workbench.locator("#candidate")).toContainText(
			"新しい依頼の候補",
		);
	} finally {
		releaseOld.resolve();
		releaseNew.resolve();
	}
});

test("初期一覧取得中の新しい依頼も、会話の古い候補で上書きしない", async ({
	page,
}) => {
	await fixture.call("complete", { conversationId: "browser-initial-list" });
	const listStarted = Promise.withResolvers<void>();
	const releaseList = Promise.withResolvers<void>();
	const nextCycle = Promise.withResolvers<void>();
	let firstList = true,
		polls = 0;
	await page.route("**/api/canvas/artwork-search?**", async (route) => {
		if (firstList) {
			firstList = false;
			listStarted.resolve();
			await releaseList.promise;
		}
		await route.fallback();
	});
	await page.route("**/api/canvas/jobs/latest?**", async (route) => {
		if (++polls >= 2) nextCycle.resolve();
		await route.fallback();
	});
	try {
		await page.goto(host + "/?conversationId=browser-initial-list");
		const workbench = page.frameLocator('iframe[title="Canvasアプリ"]');
		await listStarted.promise;
		await workbench
			.getByRole("button", { name: "Canvasの会話", exact: true })
			.click();
		await workbench.locator("#message").fill("初期表示中の新しい依頼");
		await workbench.locator("#send").click();
		await expect(workbench.locator("#candidate")).toContainText(
			"初期表示中の新しい依頼",
		);
		releaseList.resolve();
		await ready(workbench);
		await nextCycle.promise;
		await expect(workbench.locator("#candidate")).toContainText(
			"初期表示中の新しい依頼",
		);
	} finally {
		releaseList.resolve();
	}
});

test("狭い画面でも古い作品を検索し、作品を開ける", async ({ page }) => {
	await fixture.call("seed", { count: 26 });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(host + "/?conversationId=browser-search");
	const workbench = page.frameLocator('iframe[title="Canvasアプリ"]');
	await ready(workbench);
	await workbench
		.getByRole("button", { name: "作品一覧と版履歴", exact: true })
		.click();
	await workbench.locator("#artwork-query").fill("保存作品00");
	await workbench.locator('#artwork-search button[type="submit"]').click();
	await expect(workbench.locator("#artworks button")).toHaveCount(1);
	await workbench.locator("#artworks button").click();
	await expect(workbench.locator("#current")).toContainText("保存作品00");
	await page.screenshot({ path: "test-results/canvas-app/narrow-search.png" });
});

test("実Chromiumの観測で時間だけの変化と入力による変化を区別する", async () => {
	const draw =
		'api.ctx.fillStyle="#fff";api.ctx.fillRect(0,0,api.width,api.height);api.ctx.fillStyle="#2463eb";';
	const automatic = `canvasApp.start(api=>({frame(t){${draw}api.ctx.fillRect(20+t/50,60,30,30);}}));`;
	const interactive = `canvasApp.start(api=>{let x=20;return {frame(){${draw}api.ctx.fillRect(x,60,30,30);},input(e){if(e.type==="keydown"&&e.code==="ArrowRight")x+=30;}}});`;
	const first = await fixture.call<{
		checks: Array<{ id: string; pass: boolean }>;
	}>("observe", { entry: automatic });
	expect(first.checks.find((check) => check.id === "responds")?.pass).toBe(
		false,
	);
	expect(
		first.checks.find((check) => check.id === "input-comparison")?.pass,
	).toBe(true);
	const second = await fixture.call<{
		checks: Array<{ id: string; pass: boolean }>;
	}>("observe", { entry: interactive });
	expect(second.checks.find((check) => check.id === "responds")?.pass).toBe(
		true,
	);
	const conditional = `canvasApp.start(api=>{let armed=false,x=20;return {frame(){${draw}api.ctx.fillRect(x,60,30,30);},input(e){if(e.type!=="keydown")return;if(e.code==="ArrowRight")armed=true;if(e.code==="Space"&&armed)x+=30;}}});`;
	const steps = await fixture.call<typeof second>("observe", {
		entry: conditional,
		controls: [
			{ kind: "key", input: "ArrowRight", action: "準備する", always: true },
			{ kind: "key", input: "Space", action: "準備後に移動", always: false },
		],
	});
	expect(steps.checks.find((check) => check.id === "responds")?.pass).toBe(
		true,
	);
	const inactive = await fixture.call<typeof second>("observe", {
		entry: conditional,
		controls: [
			{ kind: "key", input: "Space", action: "準備後に移動", always: false },
		],
	});
	expect(inactive.checks.find((check) => check.id === "responds")?.pass).toBe(
		false,
	);
	const broken = await fixture.call<typeof second>("observe", {
		entry: `canvasApp.start(api=>({frame(){${draw}api.ctx.fillRect(20,60,30,30);},input(e){if(e.type==="keydown")throw new Error("fixture input failure");}}));`,
	});
	expect(
		broken.checks.find((check) => check.id === "no-runtime-error")?.pass,
	).toBe(false);
});
