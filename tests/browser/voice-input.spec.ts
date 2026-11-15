import { mkdtempSync, rmSync, readFileSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createFixture } from "./fixture";

test.use({
	launchOptions: { args: ["--mute-audio"] },
	screenshot: "only-on-failure",
});
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
	const logs = join(dir, "logs");
	if (existsSync(logs))
		cpSync(logs, test.info().outputPath("logs"), { recursive: true });
	rmSync(dir, { recursive: true, force: true });
});

test("fragments spoken again before their transcript is sent create one conversation request and one answer", async ({
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
		// The speaker resumes while each earlier fragment is still being transcribed.
		body: JSON.stringify(
			fragments.map((text, i) => ({ text, delayMs: i < 2 ? 2000 : 0 })),
		),
	});
	await page.route("**/fixture-input.wav", (route) =>
		route.fulfill({
			contentType: "audio/wav",
			body: readFileSync("tests/browser/fixtures/asr-utterance.wav"),
		}),
	);
	await page.addInitScript(() => {
		Object.defineProperty(window, "WebGL2RenderingContext", {
			value: undefined,
		});
		Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
			configurable: true,
			value: async () => {
				const context = new AudioContext(),
					output = context.createMediaStreamDestination();
				const buffer = await context.decodeAudioData(
					await (await fetch("/fixture-input.wav")).arrayBuffer(),
				);
				Reflect.set(window, "triggerSpeech", async () => {
					await context.resume();
					if (context.state !== "running")
						throw new Error("fixture_audio_not_running");
					const source = context.createBufferSource();
					source.buffer = buffer;
					source.loop = true;
					source.connect(output);
					source.start();
					Reflect.set(window, "finishSpeech", () => source.stop());
				});
				return output.stream;
			},
		});
	});
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
	await expect(page.locator(".composer-status")).toContainText(
		"話しかけてください",
	);
	for (let i = 0; i < 3; i++) {
		await page.evaluate(() => Reflect.get(window, "triggerSpeech")());
		await expect(page.locator(".composer-status")).toContainText("聞き取り中");
		expect(ids).toHaveLength(i);
		// Nothing is sent while the speaker is still talking.
		expect(commits).toHaveLength(0);
		await page.evaluate(() => Reflect.get(window, "finishSpeech")());
		await expect.poll(() => ids.length).toBe(i + 1);
		// The final, undelayed result may already be committed when its upload settles.
		if (i < 2) expect(commits).toHaveLength(0);
	}
	try {
		await expect.poll(() => commits.length).toBe(1);
	} catch (error) {
		console.log(
			"input status",
			await page.locator(".composer-status").innerText(),
		);
		for (const id of ids) {
			const turn = await getTurn(id);
			console.log({
				id,
				status: turn.status,
				error: turn.error,
				revision: turn.revision,
			});
		}
		throw error;
	}
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
	const observations = await (
		await fetch(`http://127.0.0.1:${larmPort}/fixture/observations`, {
			headers: { Authorization: "Bearer fixture-control" },
		})
	).json();
	expect(observations.asrInputs).toHaveLength(3);
	await page.getByRole("button", { name: "マイクを停止" }).click();
});
