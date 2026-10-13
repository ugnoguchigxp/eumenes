import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture } from "./fixture";
import { createClient } from "../../client";
import { openFromLauncher } from "./artifact-launcher";
const fixture = createFixture();
const token = "settings-voice-sample-fixture-token";
let dir: string, apiPort: number, webPort: number, larmPort: number;
test.setTimeout(60000);
test.beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "eumenes-sample-browser-"));
	({ apiPort, webPort, larmPort } = await fixture.startVoiceStack({
		dir,
		token,
	}));
});
test.afterAll(async () => {
	await fixture.stopAll();
	if (dir) rmSync(dir, { recursive: true, force: true });
});
test("sample passes through the real API, plays decoded audio, follows volume, stops on close and restores defaults", async ({
	page,
}) => {
	await page.addInitScript(() => {
		const AudioConstructor = window.Audio;
		Object.defineProperty(window, "Audio", {
			value: function (src?: string) {
				const audio = new AudioConstructor(src);
				Object.assign(window, { lastSampleAudio: audio });
				return audio;
			},
		});
	});
	const client = createClient(`http://127.0.0.1:${apiPort}`, token);
	const baseline = await client.settings();
	await page.goto(`http://127.0.0.1:${webPort}`);
	await openFromLauncher(page, "設定");
	const artifact = page.getByRole("complementary", {
		name: "アーティファクト",
	});
	await artifact
		.getByRole("button", { name: "音声と入力", exact: true })
		.click();
	await expect(
		artifact.getByLabel("キャラクター", { exact: true }),
	).toBeEnabled();
	await artifact
		.getByLabel("キャラクター", { exact: true })
		.selectOption("fixture-voice-soft");
	const speed = artifact.getByRole("slider", { name: /^話す速さ/ });
	await speed.focus();
	await speed.press("Home");
	for (let i = 0; i < 6; i++) await speed.press("ArrowRight");
	const response = page.waitForResponse(
		(r) =>
			r.url().endsWith("/api/voice/sample") && r.request().method() === "POST",
	);
	await artifact
		.getByRole("button", { name: "サンプルを再生", exact: true })
		.click();
	expect((await response).status()).toBe(200);
	await expect(
		artifact.getByRole("button", { name: "サンプルを停止", exact: true }),
	).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as unknown as { lastSampleAudio: HTMLAudioElement })
						.lastSampleAudio.currentTime,
			),
		)
		.toBeGreaterThan(0.1);
	const observation = await (
		await fetch(`http://127.0.0.1:${larmPort}/fixture/observations`, {
			headers: { Authorization: "Bearer fixture-control" },
		})
	).json();
	expect(observation.ttsParameters.at(-1)).toMatchObject({
		voice: "fixture-voice-soft",
		style: "sweet",
		speed: 1.1,
	});
	const volume = artifact.getByRole("slider", { name: /^音量/ });
	await volume.focus();
	await volume.press("End");
	await volume.press("ArrowLeft");
	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(window as unknown as { lastSampleAudio: HTMLAudioElement })
						.lastSampleAudio.volume,
			),
		)
		.toBeCloseTo(0.95);
	await artifact
		.getByRole("button", { name: "サンプルを停止", exact: true })
		.click();
	expect(
		await page.evaluate(
			() =>
				(window as unknown as { lastSampleAudio: HTMLAudioElement })
					.lastSampleAudio.paused,
		),
	).toBe(true);
	// Closing while playing must stop the actual browser audio and keep only the shared draft.
	await artifact
		.getByRole("button", { name: "サンプルを再生", exact: true })
		.click();
	await expect(
		artifact.getByRole("button", { name: "サンプルを停止", exact: true }),
	).toBeVisible();
	await artifact
		.getByRole("button", { name: "音声と入力を閉じる", exact: true })
		.click();
	expect(
		await page.evaluate(
			() =>
				(window as unknown as { lastSampleAudio: HTMLAudioElement })
					.lastSampleAudio.paused,
		),
	).toBe(true);
	await artifact.getByRole("tab", { name: "設定", exact: true }).click();
	await artifact
		.getByRole("button", { name: "音声と入力", exact: true })
		.click();
	await expect(
		artifact.getByLabel("キャラクター", { exact: true }),
	).toHaveValue("fixture-voice-soft");
	await artifact.getByLabel("キャラクター", { exact: true }).selectOption("");
	await artifact.getByText("詳細設定", { exact: true }).click();
	await artifact
		.getByLabel("話し方（スタイル）", { exact: true })
		.selectOption("");
	const defaultResponse = page.waitForResponse((r) =>
		r.url().endsWith("/api/voice/sample"),
	);
	await artifact
		.getByRole("button", { name: "サンプルを再生", exact: true })
		.click();
	expect((await defaultResponse).status()).toBe(200);
	const defaults = await (
		await fetch(`http://127.0.0.1:${larmPort}/fixture/observations`, {
			headers: { Authorization: "Bearer fixture-control" },
		})
	).json();
	expect(defaults.ttsParameters.at(-1).voice).toBe("fixture-voice");
	expect(defaults.ttsParameters.at(-1)).not.toHaveProperty("style");
	await expect(
		artifact.getByRole("button", { name: "サンプルを停止", exact: true }),
	).toBeVisible();
	await artifact
		.getByRole("button", { name: "サンプルを停止", exact: true })
		.click();
	expect(await client.settings()).toEqual(baseline);
	await artifact.getByRole("button", { name: "変更一覧を開く" }).click();
	await artifact
		.getByRole("button", { name: "未適用の設定変更をすべて破棄" })
		.click();
	await artifact.getByRole("tab", { name: "音声と入力", exact: true }).click();
	await expect(
		artifact.getByLabel("キャラクター", { exact: true }),
	).toHaveValue(baseline.larm.voice);
	await expect(
		artifact.getByText("すべての変更を保存済み", { exact: true }),
	).toBeVisible();
});
