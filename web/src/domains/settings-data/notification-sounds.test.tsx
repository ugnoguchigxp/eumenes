import { readFileSync } from "node:fs";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ArtifactDefinitionV1 } from "../../../../api/domains/capabilities/contracts";
import { notificationSoundOptions } from "../../../../api/domains/settings/contracts";
import { createSettingsBackend, newCache, Screens } from "./settings.fixture";
const fake = vi.hoisted(() => ({
	load: vi.fn(
		async (_choice?: string, _signal?: AbortSignal) =>
			new Uint8Array([1, 2, 3]),
	),
	output: {
		startOutput: vi.fn(async () => {}),
		play: vi.fn(async (_bytes, _ended, options) => {
			options.onStarted();
		}),
		stopPlayback: vi.fn(),
		stop: vi.fn(async () => {}),
	},
}));
vi.mock("../settings/notification-sound", () => ({
	notificationSoundWav: fake.load,
}));
vi.mock("../audio/controller", () => ({
	createAudioController: () => fake.output,
}));
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});
const bundle = JSON.parse(
	readFileSync("api/domains/capabilities/bundles/settings.bundle.json", "utf8"),
) as { artifacts: ArtifactDefinitionV1[] };
const notificationBundle = JSON.parse(
	readFileSync(
		"api/domains/capabilities/bundles/settings.notification-sounds.bundle.json",
		"utf8",
	),
) as { artifacts: ArtifactDefinitionV1[] };
const artifacts = Object.fromEntries(
	[...bundle.artifacts, ...notificationBundle.artifacts]
		.filter((a) => a.id !== "settings.records")
		.map((a) => [a.id.replace(/^settings\./, ""), a]),
);

test("shipped picker previews the unsaved choice on configured output, stops on change, saves and reopens", async () => {
	const backend = createSettingsBackend({ artifacts });
	const saved = backend.saved();
	saved.voice.outputDevice = "speaker-2";
	saved.voice.outputVolume = 0.4;
	backend.setSaved(saved);
	render(
		<Screens backend={backend} start="voice-input" cache={newCache(backend)} />,
	);
	fireEvent.click(await screen.findByRole("button", { name: "通知音" }));
	const picker = await screen.findByLabelText("通知音の種類");
	for (const option of notificationSoundOptions)
		expect(screen.getByRole("option", { name: option.label })).toBeTruthy();
	expect((picker as HTMLSelectElement).value).toBe("soft-chime");
	fireEvent.change(picker, { target: { value: "glass-bell" } });
	fireEvent.click(screen.getByRole("button", { name: "通知音を試聴" }));
	await waitFor(() => expect(fake.output.play).toHaveBeenCalledOnce());
	expect(fake.load.mock.calls[0]?.[0]).toBe("glass-bell");
	expect(fake.output.play.mock.calls[0]?.[2]).toMatchObject({
		volume: 0.4,
		suppressInput: true,
	});
	expect(backend.saved().voice.notificationSound).toBeUndefined();
	fireEvent.change(picker, { target: { value: "beep" } });
	await waitFor(() => expect(fake.output.stopPlayback).toHaveBeenCalled());
	fireEvent.click(screen.getByRole("button", { name: "通知音を試聴" }));
	await screen.findByRole("button", { name: "通知音の試聴を停止" });
	fireEvent.click(screen.getByRole("button", { name: "通知音の試聴を停止" }));
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて保存" }),
	);
	await waitFor(() =>
		expect(backend.saved().voice.notificationSound).toBe("beep"),
	);
	fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
	fireEvent.click(screen.getByRole("button", { name: "開く:voice-input" }));
	fireEvent.click(await screen.findByRole("button", { name: "通知音" }));
	expect(
		((await screen.findByLabelText("通知音の種類")) as HTMLSelectElement).value,
	).toBe("beep");
});

test("a saved retired choice stays readable until the user selects an approved sound", async () => {
	const backend = createSettingsBackend({ artifacts });
	const saved = backend.saved();
	saved.voice.notificationSound = "tiny-harp";
	backend.setSaved(saved);
	render(
		<Screens backend={backend} start="voice-input" cache={newCache(backend)} />,
	);
	fireEvent.click(await screen.findByRole("button", { name: "通知音" }));
	const picker = await screen.findByLabelText("通知音の種類");
	expect((picker as HTMLSelectElement).value).toBe("tiny-harp");
	expect(
		screen.getByRole("option", { name: "再制作待ち（以前の通知音）" }),
	).toBeTruthy();
	expect(
		screen
			.getByRole("button", { name: "通知音を試聴" })
			.hasAttribute("disabled"),
	).toBe(true);
	expect(backend.saved().voice.notificationSound).toBe("tiny-harp");
	fireEvent.change(picker, { target: { value: "glass-bell" } });
	expect(
		screen
			.getByRole("button", { name: "通知音を試聴" })
			.hasAttribute("disabled"),
	).toBe(false);
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて保存" }),
	);
	await waitFor(() =>
		expect(backend.saved().voice.notificationSound).toBe("glass-bell"),
	);
});
