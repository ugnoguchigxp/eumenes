import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createFixture } from "./fixture";

const fixture = createFixture();
const token = "fixture-api-token-0123456789abcdef";
let dir: string, apiPort: number, webPort: number, larmPort: number;
test.beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "eumenes-input-browser-"));
	({ apiPort, webPort, larmPort } = await fixture.startVoiceStack({
		dir,
		token,
	}));
});
test.afterAll(async () => {
	await fixture.stopAll();
	rmSync(dir, { recursive: true, force: true });
});

test("three paused ASR fragments create one conversation request and one answer", async ({
	page,
}) => {
	const fragments = [
		"明日の予定を。",
		"いえ、来週の予定を。",
		"教えてください。",
	];
	await fetch(`http://127.0.0.1:${larmPort}/fixture/voice-inputs`, {
		method: "POST",
		headers: {
			Authorization: "Bearer fixture-control",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(
			fragments.map((text, i) => ({
				text,
				relation: i ? "continuation" : "independent",
				readiness: i === 2 ? "ready" : "waiting",
			})),
		),
	});
	await page.addInitScript(() => {
		Object.defineProperty(window, "WebGL2RenderingContext", {
			value: undefined,
		});
		Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
			configurable: true,
			value: async () => {
				const context = new AudioContext(),
					output = context.createMediaStreamDestination();
				Reflect.set(window, "triggerSpeech", () => {
					const oscillator = context.createOscillator(),
						gain = context.createGain();
					gain.gain.value = 0.2;
					oscillator.connect(gain);
					gain.connect(output);
					oscillator.start();
					Reflect.set(window, "finishSpeech", () => oscillator.stop());
				});
				return output.stream;
			},
		});
	});
	// Provisional recognition must not consume the scripted final-ASR responses.
	let preview = "";
	await page.route("**/api/voice/preview", (route) =>
		route.fulfill({ json: { utteranceId: "preview", text: preview } }),
	);
	const ids: string[] = [],
		commits: string[] = [];
	page.on("request", (request) => {
		if (request.method() !== "POST") return;
		const path = new URL(request.url()).pathname;
		if (path === "/api/voice/turns")
			ids.push(request.headers()["x-utterance-id"]!);
		if (path.endsWith("/commit")) commits.push(path);
	});
	const getTurn = async (id: string) =>
		(
			await fetch(`http://127.0.0.1:${apiPort}/api/voice/turns/${id}`, {
				headers: { Authorization: `Bearer ${token}` },
			})
		).json();
	await page.goto(`http://127.0.0.1:${webPort}/`);
	await page.getByRole("button", { name: "音声を開始" }).click();
	await page.waitForFunction(
		() => typeof Reflect.get(window, "triggerSpeech") === "function",
	);
	for (let i = 0; i < 3; i++) {
		preview = fragments[i]!;
		await page.evaluate(() => Reflect.get(window, "triggerSpeech")());
		// While the next segment is still being recorded, earlier input stays visible.
		await expect(page.getByRole("textbox", { name: "メッセージ" })).toHaveValue(
			fragments.slice(0, i + 1).join("\n"),
		);
		expect(ids).toHaveLength(i); // This is a preview, not the final ASR result.
		await page.evaluate(() => Reflect.get(window, "finishSpeech")());
		await expect.poll(() => ids.length).toBe(i + 1);
		if (i < 2) {
			await expect
				.poll(async () => (await getTurn(ids[i]!)).status)
				.toBe("awaiting_input");
			expect(commits).toHaveLength(0);
			await expect(
				page.getByRole("textbox", { name: "メッセージ" }),
			).toHaveValue(fragments.slice(0, i + 1).join("\n"));
		}
	}
	await expect.poll(() => commits.length).toBe(1);
	await expect(page.locator(".messages .message-user")).toHaveCount(1);
	await expect(page.locator(".messages .message-user")).toContainText(
		fragments.join("\n"),
	);
	await expect(page.locator(".messages .message-assistant")).toHaveCount(1);
	await expect(page.locator(".messages .message-assistant")).toContainText(
		"承知しました。先ほどの話を覚えています。",
	);
	expect((await getTurn(ids[0]!)).status).toBe("merged");
	expect((await getTurn(ids[1]!)).status).toBe("merged");
	await page.getByRole("button", { name: "マイクを停止" }).click();
});
