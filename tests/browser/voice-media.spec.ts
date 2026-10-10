import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { createFixture } from "./fixture";

/**
 * Fixture-level browser check of the real capture path: Chromium's fake media
 * device feeds speech.wav into getUserMedia, so the AudioWorklet, the voice
 * activity detector and the turn upload all run unmodified. getUserMedia is NOT
 * replaced. This is NOT an acceptance run on a real microphone and headphones;
 * the real-device round trips stay unaccepted (docs/acceptance.md).
 */
const TOKEN = "fixture-api-token-0123456789abcdef";
const SPEECH_WAV = resolve("tests/browser/fixtures/speech.wav");
const fixture = createFixture();
let dir: string;
let larmPort: number;
let webPort: number;

test.use({
	permissions: ["microphone"],
	launchOptions: {
		args: [
			"--use-fake-ui-for-media-stream",
			"--use-fake-device-for-media-stream",
			`--use-file-for-fake-audio-capture=${SPEECH_WAV}`,
		],
	},
});

// On the development Mac, Chromium getUserMedia with fake devices never resolves
// (it blocks the browser; observed even with a bare Playwright script), so the
// spec is skipped there unless EUMENES_FAKE_MEDIA=1 forces it.
test.skip(
	process.platform === "darwin" && process.env.EUMENES_FAKE_MEDIA !== "1",
	"Chromium fake-media getUserMedia hangs on macOS",
);
test.beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "eumenes-voice-media-"));
	({ larmPort, webPort } = await fixture.startVoiceStack({
		dir,
		token: TOKEN,
	}));
});
test.afterAll(async () => {
	await fixture.stopAll();
	rmSync(dir, { recursive: true, force: true });
});

test("fake microphone speech reaches the transcript through the AudioWorklet", async ({
	page,
}) => {
	// Business UI only: keep the WebGL avatar out of the way, as voice.spec does.
	await page.addInitScript(() => {
		Object.defineProperty(window, "WebGL2RenderingContext", {
			value: undefined,
		});
	});
	await page.goto(`http://127.0.0.1:${webPort}/`);
	await page.getByRole("button", { name: "音声を開始" }).click();
	await expect(
		page.getByRole("button", { name: "マイクを停止" }),
	).toBeVisible();
	await expect(
		page.locator(".messages").getByText("こんにちは", { exact: true }).first(),
	).toBeVisible({ timeout: 30000 });
	const observations = (await (
		await fetch(`http://127.0.0.1:${larmPort}/fixture/observations`, {
			headers: { Authorization: "Bearer fixture-control" },
		})
	).json()) as { asrInputs: Array<{ rate: number; bytes: number }> };
	// The file loops, so more than one turn may already be uploaded.
	expect(observations.asrInputs.length).toBeGreaterThanOrEqual(1);
	expect(observations.asrInputs[0]!.bytes).toBeGreaterThan(44);
	await page.getByRole("button", { name: "マイクを停止" }).click();
	await expect(page.getByRole("button", { name: "音声を開始" })).toBeEnabled();
});
