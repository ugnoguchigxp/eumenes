import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { VoiceCatalog } from "./voice-presentation";
import { createSettingsBackend, newCache, Screens } from "./settings.fixture";

const catalog: VoiceCatalog = {
	model: "example-capability-tts",
	default_voice: "female",
	voices: [
		{
			id: "female",
			display_name: "女性の声",
			voice_presentation: "feminine",
			default_style: "normal",
			styles: [
				{ id: "normal", display_name: "ノーマル" },
				{ id: "bright", display_name: "明るい" },
			],
			capabilities: {
				speed: { minimum: 0.8, maximum: 1.3, default: 1 },
				pitch_scale: { minimum: -0.1, maximum: 0.1, default: 0 },
				intonation_scale: { minimum: 0, maximum: 1.5, default: 1 },
			},
			credit: "Example voice",
		},
		{
			id: "simple",
			display_name: "シンプルな声",
			styles: [],
			capabilities: {},
		},
	],
};
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function openVoice(options?: Parameters<typeof createSettingsBackend>[0]) {
	const backend = createSettingsBackend(options);
	backend.client.larmVoices.mockResolvedValue(catalog);
	const view = render(
		<Screens backend={backend} start="voice-input" cache={newCache(backend)} />,
	);
	return { backend, ...view };
}
const ready = () => screen.findByText(/サービスが対応する調整項目/);
const saveButton = () =>
	screen.getByRole("button", { name: "設定の変更をすべて保存" });

test("capabilities, not model names, expose styles and ranges; changing character resets incompatible values", async () => {
	openVoice();
	await waitFor(() =>
		expect(
			(screen.getByLabelText("キャラクター") as HTMLSelectElement).disabled,
		).toBe(false),
	);
	fireEvent.click(screen.getByText("詳細設定"));
	expect(screen.getByLabelText("話し方（スタイル）")).toBeTruthy();
	expect((screen.getByLabelText(/声の高さ/) as HTMLInputElement).min).toBe(
		"-0.1",
	);
	expect((screen.getByLabelText(/話す速さ/) as HTMLInputElement).max).toBe(
		"1.3",
	);
	fireEvent.change(screen.getByLabelText("キャラクター"), {
		target: { value: "simple" },
	});
	expect(screen.queryByLabelText("話し方（スタイル）")).toBeNull();
	expect(screen.queryByLabelText(/話す速さ/)).toBeNull();
	expect(screen.queryByLabelText(/抑揚/)).toBeNull();
});

test("cloud-only offers one TTS form without starting LARM or classifier calls", async () => {
	const { backend } = openVoice({ cloud: true });
	expect(await screen.findByLabelText(/の音声ID/)).toBeTruthy();
	expect(screen.queryByLabelText("キャラクター")).toBeNull();
	expect(screen.queryByRole("button", { name: "サンプルを再生" })).toBeNull();
	expect(backend.client.larmVoices).not.toHaveBeenCalled();
});

test("voice and input save their shared draft from any group without opening review", async () => {
	const { backend } = openVoice();
	await ready();
	fireEvent.change(screen.getByLabelText(/^音量/), {
		target: { value: "0.55" },
	});
	for (const group of ["読み上げ", "聞き取り", "機器"]) {
		fireEvent.click(screen.getByRole("button", { name: group }));
		expect(saveButton()).toHaveProperty("disabled", false);
	}
	fireEvent.click(saveButton());
	await screen.findByText("変更を適用しました");
	expect(backend.saved().voice.outputVolume).toBe(0.55);
	expect(saveButton()).toHaveProperty("disabled", true);
});

test("input and cloud edits join the shared change review and save to the registered fields", async () => {
	const { backend } = openVoice({ cloud: false });
	await ready();
	fireEvent.change(screen.getByLabelText("調整する読み上げ先"), {
		target: { value: backend.cloud.id },
	});
	fireEvent.change(screen.getByLabelText(/の音声ID/), {
		target: { value: "nova" },
	});
	fireEvent.click(screen.getByRole("button", { name: "聞き取り" }));
	fireEvent.click(screen.getByLabelText("英語"));
	fireEvent.click(screen.getByText("詳細設定"));
	fireEvent.change(screen.getByLabelText("発話を確定する無音時間（ミリ秒）"), {
		target: { value: "1800" },
	});
	fireEvent.click(screen.getByRole("button", { name: "変更一覧を開く" }));
	await screen.findByText("音声と入力 / 利用する言語");
	expect(
		screen.getByText("音声と入力 / クラウド音声 / multilingual の音声ID"),
	).toBeTruthy();
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて適用" }),
	);
	await screen.findByText("変更を適用しました");
	const saved = backend.saved();
	expect(saved.general.asrLanguages).toEqual(["ja"]);
	expect(saved.voice.silenceMs).toBe(1800);
	expect(saved.resources[0]!.voice).toBe("nova");
	expect(saved.routes.tts.mode).toBe("larm-preferred");
	// The wire carries strings; the adapter reads them back into the document's types.
	expect(backend.sent[0]!.input).toMatchObject({
		changes: expect.arrayContaining([
			{
				fieldId: "speech.cloud.voice",
				target: backend.cloud.id,
				value: "nova",
			},
			{ fieldId: "input.languages", value: '["ja"]' },
			{ fieldId: "input.silence-ms", value: "1800" },
		]),
	});
});

test("invalid numbers and language sets are refused and never reach the draft", async () => {
	const { backend } = openVoice();
	await ready();
	fireEvent.click(screen.getByRole("button", { name: "聞き取り" }));
	fireEvent.click(screen.getByText("詳細設定"));
	const silence = screen.getByLabelText("発話を確定する無音時間（ミリ秒）");
	for (const bad of ["300.5", "100", "99999", "abc"])
		fireEvent.change(silence, { target: { value: bad } });
	expect(saveButton()).toHaveProperty("disabled", true);
	// Unchecking every language is refused: at least one must stay selected.
	fireEvent.click(screen.getByLabelText("日本語"));
	fireEvent.click(screen.getByLabelText("英語"));
	expect((screen.getByLabelText("英語") as HTMLInputElement).checked).toBe(
		true,
	);
	expect(backend.sent).toHaveLength(0);
});

test("device permission is explicit and every acquired track stops, including late permission after closing", async () => {
	let finish!: (stream: MediaStream) => void;
	const stop = vi.fn();
	const enumerate = vi.fn(async () => []);
	const getUserMedia = vi.fn(
		() =>
			new Promise<MediaStream>((resolve) => {
				finish = resolve;
			}),
	);
	vi.stubGlobal("navigator", {
		mediaDevices: { getUserMedia, enumerateDevices: enumerate },
	});
	const view = openVoice();
	await ready();
	expect(getUserMedia).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "機器" }));
	fireEvent.click(screen.getByRole("button", { name: "音声機器を確認" }));
	view.unmount();
	await act(async () => {
		finish({ getTracks: () => [{ stop }] } as unknown as MediaStream);
	});
	expect(stop).toHaveBeenCalledOnce();
	expect(enumerate).not.toHaveBeenCalled();
});

test("every registered voice/input setting reaches the shared draft, applies, and discards without changing routing", async () => {
	class Context {
		async setSinkId() {}
	}
	vi.stubGlobal("AudioContext", Context);
	const stop = vi.fn();
	vi.stubGlobal("navigator", {
		mediaDevices: {
			getUserMedia: async () => ({ getTracks: () => [{ stop }] }),
			enumerateDevices: async () => [
				{ deviceId: "mic-test", kind: "audioinput", label: "マイク" },
				{ deviceId: "speaker-test", kind: "audiooutput", label: "スピーカー" },
			],
		},
	});
	const { backend } = openVoice({ cloud: false });
	await ready();
	fireEvent.click(screen.getByRole("button", { name: "機器" }));
	fireEvent.click(screen.getByRole("button", { name: "音声機器を確認" }));
	await screen.findByRole("option", { name: "マイク" });
	expect(stop).toHaveBeenCalledOnce();
	const set = (label: string | RegExp, value: string) =>
		fireEvent.change(screen.getByLabelText(label), { target: { value } });
	fireEvent.click(screen.getByRole("button", { name: "読み上げ" }));
	fireEvent.click(screen.getByLabelText("回答を読み上げる"));
	set(/^音量/, ".7");
	fireEvent.click(screen.getByLabelText("話し始めたら読み上げを止める"));
	set("キャラクター", "female");
	fireEvent.click(screen.getByText("詳細設定"));
	set("話し方（スタイル）", "bright");
	set(/話す速さ/, "1.1");
	set(/声の高さ/, ".05");
	set(/^抑揚/, "1.4");
	fireEvent.click(screen.getByLabelText(/文章に合わせて抑揚/));
	set(/自動調整の強さ/, "1.5");
	fireEvent.click(screen.getByRole("button", { name: "聞き取り" }));
	fireEvent.click(screen.getByLabelText("フランス語"));
	set("声を検出するしきい値", ".012");
	set("発話を確定する無音時間（ミリ秒）", "2100");
	for (const label of [
		"エコーを抑える",
		"周囲の雑音を抑える",
		"マイクの音量を自動調整する",
	])
		fireEvent.click(screen.getByLabelText(label));
	fireEvent.click(screen.getByRole("button", { name: "機器" }));
	set("マイク", "mic-test");
	set("再生機器", "speaker-test");
	fireEvent.click(screen.getByRole("button", { name: "読み上げ" }));
	set("調整する読み上げ先", backend.cloud.id);
	set(/の音声ID/, "nova");
	set(/の話す速さ/, "1.2");
	fireEvent.click(screen.getByRole("button", { name: "変更一覧を開く" }));
	await screen.findByText("音声と入力 / 利用する言語");
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて適用" }),
	);
	await screen.findByText("変更を適用しました");
	const saved = backend.saved();
	expect(saved.voice).toMatchObject({
		autoSpeak: false,
		outputVolume: 0.7,
		bargeIn: false,
		threshold: 0.012,
		silenceMs: 2100,
		echoCancellation: false,
		noiseSuppression: false,
		autoGainControl: false,
		inputDevice: "mic-test",
		outputDevice: "speaker-test",
	});
	expect(saved.general.asrLanguages).toEqual(
		expect.arrayContaining(["ja", "fr"]),
	);
	expect(saved.larm).toMatchObject({
		voice: "female",
		style: "bright",
		speed: 1.1,
		pitchScale: 0.05,
		intonationScale: 1.4,
		autoIntonation: true,
		autoStrength: 1.5,
	});
	expect(saved.resources[0]).toMatchObject({ voice: "nova", speed: 1.2 });
	expect(saved.routes.tts.mode).toBe("larm-preferred");
});

test("voice actions refresh the catalog, and cancel playback", async () => {
	const { backend } = openVoice();
	let finish!: (v: Uint8Array<ArrayBuffer>) => void;
	backend.client.voiceSample.mockImplementationOnce(
		(_voice: unknown, _signal?: AbortSignal) =>
			new Promise<Uint8Array<ArrayBuffer>>((resolve) => {
				finish = resolve;
			}),
	);
	await ready();
	await waitFor(() =>
		expect(
			(
				screen.getByRole("button", {
					name: "サンプルを再生",
				}) as HTMLButtonElement
			).disabled,
		).toBe(false),
	);
	fireEvent.click(screen.getByRole("button", { name: "サンプルを再生" }));
	await screen.findByRole("button", { name: "サンプルの準備を取消" });
	const signal = backend.client.voiceSample.mock.calls[0]![1] as AbortSignal;
	fireEvent.click(screen.getByRole("button", { name: "サンプルの準備を取消" }));
	expect(signal.aborted).toBe(true);
	await act(async () => finish(new Uint8Array([1])));
	await screen.findByRole("button", { name: "サンプルを再生" });
	const calls = backend.client.larmVoices.mock.calls.length;
	fireEvent.click(screen.getByRole("button", { name: "声の一覧を再取得" }));
	await waitFor(() =>
		expect(backend.client.larmVoices.mock.calls.length).toBeGreaterThan(calls),
	);
});

test("the change review names values as the screen that owns the field does: languages and devices", async () => {
	class Context {
		async setSinkId() {}
	}
	vi.stubGlobal("AudioContext", Context);
	vi.stubGlobal("navigator", {
		mediaDevices: {
			getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }),
			enumerateDevices: async () => [
				{
					deviceId: "mic-test",
					kind: "audioinput",
					label: "ヘッドセットのマイク",
				},
			],
		},
	});
	openVoice();
	await ready();
	fireEvent.click(screen.getByRole("button", { name: "聞き取り" }));
	fireEvent.click(screen.getByLabelText("英語"));
	fireEvent.click(screen.getByRole("button", { name: "機器" }));
	fireEvent.click(screen.getByRole("button", { name: "音声機器を確認" }));
	await screen.findByRole("option", { name: "ヘッドセットのマイク" });
	fireEvent.change(screen.getByLabelText("マイク"), {
		target: { value: "mic-test" },
	});
	fireEvent.click(screen.getByRole("button", { name: "変更一覧を開く" }));
	await screen.findByText("音声と入力 / 利用する言語");
	// The review screen has no options of its own: it reads them where the fields were registered.
	expect(screen.getByText("日本語、英語")).toBeTruthy();
	expect(screen.getByText("日本語")).toBeTruthy();
	expect(screen.getByText("ヘッドセットのマイク")).toBeTruthy();
	expect(screen.queryByText("mic-test")).toBeNull();
});
