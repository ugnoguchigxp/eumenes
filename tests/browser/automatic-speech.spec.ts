import {
	mkdtempSync,
	readFileSync,
	existsSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createFixture } from "./fixture";

const fixture = createFixture();
const token = "fixture-api-token-0123456789abcdef";
let dir: string, apiPort: number, webPort: number, larmPort: number;
test.beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "eumenes-automatic-speech-"));
	({ apiPort, webPort, larmPort } = await fixture.startVoiceStack({
		dir,
		token,
	}));
});
test.afterEach(async ({ page: _page }, info) => {
	if (info.status === info.expectedStatus) return;
	const log = join(dir, "logs/api.jsonl");
	if (existsSync(log)) {
		const output = info.outputPath("backend.jsonl");
		writeFileSync(output, readFileSync(log));
		await info.attach("backend-log", {
			path: output,
			contentType: "application/x-ndjson",
		});
	}
});
test.afterAll(async () => {
	await fixture.stopAll();
	rmSync(dir, { recursive: true, force: true });
});
const api = (path: string, init: RequestInit = {}) =>
	fetch(`http://127.0.0.1:${apiPort}${path}`, {
		...init,
		headers: { Authorization: `Bearer ${token}`, ...init.headers },
	});
const control = (path: string) =>
	fetch(`http://127.0.0.1:${larmPort}/fixture/${path}`, {
		headers: { Authorization: "Bearer fixture-control" },
	});

for (const { microphone, external } of [
	{ microphone: false, external: false },
	{ microphone: true, external: false },
	{ microphone: true, external: true },
]) {
	test(`${external ? "externally submitted" : "typed"} adopted answer is spoken once with microphone ${microphone ? "on" : "off"}`, async ({
		page,
	}) => {
		await page.addInitScript(() => {
			Reflect.set(window, "speechEnded", 0);
			const start = AudioBufferSourceNode.prototype.start;
			AudioBufferSourceNode.prototype.start = function (...args) {
				this.addEventListener("ended", () =>
					Reflect.set(
						window,
						"speechEnded",
						Reflect.get(window, "speechEnded") + 1,
					),
				);
				return start.apply(this, args);
			};
			Object.defineProperty(window, "WebGL2RenderingContext", {
				value: undefined,
			});
			Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
				configurable: true,
				value: async () =>
					new AudioContext().createMediaStreamDestination().stream,
			});
		});
		await control("hold-next");
		await page.goto(`http://127.0.0.1:${webPort}/`);
		if (microphone)
			await page
				.getByRole("button", { name: "音声を開始", exact: true })
				.click();
		await page.getByRole("textbox", { name: "メッセージ" }).fill("こんにちは");
		const speechRequests: string[] = [];
		page.on("request", (request) => {
			if (new URL(request.url()).pathname === "/api/voice/replay/audio")
				speechRequests.push(request.postDataJSON().runId);
		});
		try {
			if (external) {
				const accepted = await api("/api/runs", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						requestId: crypto.randomUUID(),
						conversationId: "main",
						text: "こんにちは",
					}),
				});
				expect(accepted.ok).toBe(true);
			} else
				await page.getByRole("button", { name: "送信", exact: true }).click();
			await expect(
				page.locator('.message-assistant[aria-busy="true"]'),
			).toContainText("承知しました。");
			expect((await (await control("observations")).json()).ttsInputs).toEqual(
				[],
			);
			await control("release");
			await expect
				.poll(
					async () => (await (await control("observations")).json()).ttsInputs,
				)
				.toEqual(["承知しました。", "先ほどの話を覚えています。"]);
			await expect(
				page.getByRole("button", { name: "ミュート", exact: true }),
			).toBeVisible();
			const runs = await (await api("/api/conversations/main/runs")).json();
			const run = runs.at(-1);
			expect(run.status).toBe("completed");
			expect(run.sourceKind).toBe("manual");
			expect(speechRequests).toEqual([run.id, run.id]);
			await expect(
				page.getByRole("button", {
					name: microphone ? "マイクを停止" : "音声を開始",
					exact: true,
				}),
			).toBeVisible();
			await expect(
				page.getByRole("button", { name: "読み上げを停止" }),
			).toHaveCount(0);
			await expect
				.poll(() => page.evaluate(() => Reflect.get(window, "speechEnded")))
				.toBe(2);
			// A refetch/reload must never replay the adopted history.
			await page.reload();
			await expect(page.locator(".message-assistant").last()).toContainText(
				"先ほどの話を覚えています。",
			);
			expect(speechRequests).toHaveLength(2);
		} finally {
			await control("release");
		}
	});
}

test("autoSpeak off leaves an adopted text answer silent", async ({ page }) => {
	const settings = await (await api("/api/settings")).json();
	settings.voice.autoSpeak = false;
	const applied = await api("/api/settings/apply", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			requestId: crypto.randomUUID(),
			expectedRevision: settings.revision,
			settings,
			keys: [],
		}),
	});
	expect(applied.ok).toBe(true);
	await control("hold-next");
	await page.goto(`http://127.0.0.1:${webPort}/`);
	await page.getByRole("textbox", { name: "メッセージ" }).fill("こんにちは");
	try {
		await page.getByRole("button", { name: "送信", exact: true }).click();
		await expect(
			page.locator('.message-assistant[aria-busy="true"]'),
		).toContainText("承知しました。");
		await control("release");
		await expect
			.poll(
				async () =>
					(await (await api("/api/conversations/main/runs")).json()).at(-1)
						.status,
			)
			.toBe("completed");
		await expect(
			page.getByRole("button", { name: "ミュートを解除", exact: true }),
		).toBeVisible();
		expect((await (await control("observations")).json()).ttsInputs).toEqual(
			[],
		);
	} finally {
		await control("release");
	}
});
