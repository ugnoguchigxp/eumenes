import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifact, job } from "../../api/domains/video/test/sample.fixture";

let directory: string;
let bytes: Buffer;
test.use({ launchOptions: { args: ["--mute-audio"] } });
test.beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "eumenes-video-browser-"));
	execFileSync("bun", [
		"build",
		"tests/browser/video.fixture.tsx",
		"--target=browser",
		"--format=esm",
		'--define=process.env={"NODE_ENV":"development"}',
		"--outdir",
		directory,
	]);
	const existing = process.env.EUMENES_TEST_EXISTING_MP4;
	const path = existing ?? join(directory, "sample.mp4");
	if (!existing)
		execFileSync("ffmpeg", [
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=s=480x480:r=24",
			"-f",
			"lavfi",
			"-i",
			"anullsrc=r=48000:cl=mono",
			"-t",
			"5",
			"-c:v",
			"libx264",
			"-c:a",
			"aac",
			"-movflags",
			"+faststart",
			path,
		]);
	bytes = readFileSync(path);
});
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));

test("embedded video Artifact preserves edited prompts and settings, resumes after reload and manages saved MP4", async ({
	page,
}) => {
	const origin = "http://127.0.0.1";
	let current: {
		id: string;
		job: ReturnType<typeof job>;
		state: string;
		errorCode: null;
		revision: number;
	} | null = null;
	let saved = true;
	const posts: string[] = [];
	const deletes: string[] = [];
	const browserErrors: string[] = [];
	page.on("pageerror", (e) => browserErrors.push(e.message));
	await page.route(origin + "/__video_fixture__", (route) =>
		route.fulfill({
			contentType: "text/html",
			body: `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`,
		}),
	);
	await page.route(origin + "/fixture.css", (route) =>
		route.fulfill({
			path: join(directory, "video.fixture.css"),
			contentType: "text/css",
		}),
	);
	await page.route(origin + "/fixture.js", (route) =>
		route.fulfill({
			path: join(directory, "video.fixture.js"),
			contentType: "text/javascript",
		}),
	);
	await page.route("**/api/videos**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		// Media elements use the same-origin app proxy, which supplies the API credential.
		if (request.resourceType() !== "media")
			expect(request.headers().authorization).toBe(
				"Bearer eumenes-browser-fixture",
			);
		else expect(path).toBe(`/api/videos/${artifact.id}/content`);
		if (path === "/api/videos/service")
			return route.fulfill({
				json: {
					model: "fixture-model",
					description: "test video",
					options: {
						sizes: [
							{ width: 480, height: 480 },
							{ width: 640, height: 480 },
						],
						durations: [5, 7.5],
					},
				},
			});
		if (path === "/api/videos/workspace")
			return route.fulfill({
				json: {
					request: current,
					admission: {
						state: current?.state === "tracking" ? "active" : "idle",
					},
				},
			});
		if (path === "/api/videos/generations" && request.method() === "POST") {
			const id = request.headers()["idempotency-key"]!;
			posts.push(id);
			expect(request.postDataJSON()).toEqual({
				prompt: "海の上を飛ぶ鳥。手編集した文章。",
				title: "海辺の鳥",
				seed: 0,
				width: 640,
				height: 480,
				durationSeconds: 7.5,
			});
			current = {
				id,
				job: job("running", "generating"),
				state: "tracking",
				errorCode: null,
				revision: 1,
			};
			return route.abort("failed");
		}
		if (
			path === `/api/videos/generations/${current?.id}` &&
			request.method() === "DELETE"
		) {
			deletes.push(path);
			current!.job = job("running", "stopping", { result: artifact });
			return route.fulfill({ json: current });
		}
		if (path === "/api/videos")
			return route.fulfill({ json: { videos: saved ? [artifact] : [] } });
		if (path.endsWith("/content"))
			return route.fulfill({ contentType: "video/mp4", body: bytes });
		if (path.endsWith("/metadata"))
			return route.fulfill({
				json: {
					...artifact,
					bytes: bytes.length,
					request: { prompt: "保存済みの動画" },
				},
			});
		if (
			path === `/api/videos/${artifact.id}` &&
			request.method() === "DELETE"
		) {
			deletes.push(path);
			saved = false;
			return route.fulfill({ status: 204 });
		}
		throw new Error(`unexpected browser fixture path ${path}`);
	});
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(origin + "/__video_fixture__");
	const panel = page.getByRole("complementary", { name: "アーティファクト" });
	const chat = page.getByRole("region", { name: "会話", exact: true });
	const divider = page.getByRole("separator", {
		name: "会話とアーティファクトのサイズを調整",
	});
	await expect(chat).toBeVisible();
	await expect(divider).toHaveAttribute("aria-orientation", "vertical");
	const chatBox = (await chat.boundingBox())!;
	const panelBox = (await panel.boundingBox())!;
	expect(chatBox.x + chatBox.width).toBeLessThan(panelBox.x);
	expect(panelBox.width).toBeLessThan(850);
	const generate = panel.getByRole("button", {
		name: "動画を生成",
		exact: true,
	});
	const prompt = panel.getByRole("textbox", { name: "動画作成プロンプト" });
	const sizes = panel.getByRole("combobox", { name: "サイズ", exact: true });
	const durations = panel.getByRole("combobox", { name: "動画の長さ" });
	await expect(sizes).toHaveValue("480×480");
	await expect(durations).toHaveValue("5");
	await expect(generate).toBeDisabled();
	await panel
		.getByRole("textbox", { name: "場面", exact: true })
		.fill("海の上を飛ぶ鳥");
	await panel.getByRole("checkbox", { name: "実写風" }).check();
	await panel.getByRole("textbox", { name: "音", exact: true }).fill("波の音");
	await expect(prompt).toHaveValue(
		"場面：海の上を飛ぶ鳥\n画風：実写風\n音：波の音",
	);
	await prompt.fill("手入力の下書き");
	await panel
		.getByRole("combobox", { name: "カメラ" })
		.selectOption("横から追う");
	await expect(prompt).toHaveValue("手入力の下書き");
	await expect(generate).toBeDisabled();
	await panel.getByRole("button", { name: "選択内容を反映" }).click();
	await expect(prompt).toHaveValue(
		"場面：海の上を飛ぶ鳥\n画風：実写風\nカメラ：横から追う\n音：波の音",
	);
	await prompt.fill("海の上を飛ぶ鳥。手編集した文章。");
	await panel.getByRole("checkbox", { name: "穏やか" }).check();
	await panel.getByRole("button", { name: "編集内容を使う" }).click();
	await sizes.selectOption("640×480");
	await expect(durations).toHaveValue("5");
	await durations.selectOption("7.5");
	await expect(sizes).toHaveValue("640×480");
	await panel.getByRole("textbox", { name: /タイトル/ }).fill("海辺の鳥");
	await panel.getByRole("spinbutton", { name: /シード/ }).fill("0");
	await panel.getByRole("button", { name: "動画一覧", exact: true }).click();
	await expect(prompt).toBeHidden();
	await expect(
		panel.getByRole("heading", { name: "保存済み動画" }),
	).toBeVisible();
	await expect(chat).toBeVisible();
	await expect
		.poll(() =>
			panel
				.locator(".ds-video-thumbnail video")
				.evaluate((node: HTMLVideoElement) => node.readyState),
		)
		.toBeGreaterThanOrEqual(2);
	await panel.getByRole("button", { name: "動画生成", exact: true }).click();
	await expect(prompt).toHaveValue("海の上を飛ぶ鳥。手編集した文章。");
	await expect(panel.getByRole("checkbox", { name: "穏やか" })).toBeChecked();
	await expect(sizes).toHaveValue("640×480");
	await expect(durations).toHaveValue("7.5");
	await expect(generate).toBeEnabled();
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(divider).toHaveAttribute("aria-orientation", "horizontal");
	expect(
		await panel
			.locator(".ds-video-body")
			.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
	).toBe(true);
	await generate.evaluate((button: HTMLButtonElement) => {
		button.click();
		button.click();
	});
	await expect(page.getByText("動画を生成中", { exact: true })).toBeVisible();
	expect(posts).toHaveLength(1);
	await page.reload();
	await expect(
		page.getByRole("button", { name: "生成を取り消す" }),
	).toBeEnabled();
	await expect(sizes).toBeEnabled();
	await expect(generate).toBeDisabled();
	expect(posts).toHaveLength(1);
	expect(deletes).toHaveLength(0);
	await page.getByRole("button", { name: "生成を取り消す" }).click();
	await expect(page.getByText("ワーカーの停止を確認中")).toBeVisible();
	await expect(page.getByText("動画が完成しました")).toHaveCount(0);
	await expect(page.locator("progress")).toHaveCount(0);
	await expect(
		panel.getByLabel(artifact.title, { exact: true }),
	).toHaveAttribute("src", /^blob:/);
	expect(deletes).toHaveLength(1);
	current!.state = "finished";
	current!.job = job("cancelled");
	await expect(page.getByText("生成を取り消しました")).toBeVisible();
	await panel.getByRole("button", { name: "動画一覧", exact: true }).click();
	await panel.getByRole("button", { name: /テスト動画/ }).click();
	const player = panel.locator("video[controls]");
	await expect(player).toHaveAttribute("src", /^blob:/);
	await expect
		.poll(() => player.evaluate((node: HTMLVideoElement) => node.duration))
		.toBeCloseTo(5);
	await player.evaluate((node: HTMLVideoElement) => {
		node.muted = true;
		return node.play();
	});
	await expect
		.poll(() => player.evaluate((node: HTMLVideoElement) => node.currentTime))
		.toBeGreaterThan(0.1);
	const download = page.waitForEvent("download");
	await page.getByRole("link", { name: "MP4を保存" }).click();
	expect((await download).suggestedFilename()).toBe("テスト動画.mp4");
	await page.getByText("生成条件とファイル情報").click();
	await expect(page.getByText("動画 SHA-256")).toBeVisible();
	await page.getByRole("button", { name: "削除", exact: true }).click();
	await page.getByRole("button", { name: "削除する", exact: true }).click();
	await expect(page.getByText("保存済みの動画はありません。")).toBeVisible();
	expect(deletes).toHaveLength(2);
	expect(browserErrors).toEqual([]);
});
