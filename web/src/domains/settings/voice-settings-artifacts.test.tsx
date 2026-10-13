import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	renderHook,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { ArtifactEvent } from "@eumenes/artifact-ui";
import type { EumenesClient } from "../../../../client";
import {
	settingsSchema,
	type ApplySettings,
} from "../../../../api/domains/settings/contracts";
import { SettingsDraftProvider, useSettingsDraft } from "./SettingsDraftHost";
import { SettingsArtifact } from "./SettingsArtifact";
import { settingsArtifactDefinition } from "./artifact-definition";
import { settingsArtifactRuntime } from "./artifact-runtime";
import { useVoiceSettings } from "./useVoiceSettings";
import { settingsFixture } from "./sections/fixture";
import type { VoiceCatalog } from "./voice-presentation";
import { queryRoots } from "../../queryKeys";

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
function fixture(cloud = false) {
	let saved = settingsFixture();
	saved.larm.profile = "ornith1.5Strix";
	saved.larm.baseUrl = "http://127.0.0.1:9001";
	const connectionId = crypto.randomUUID(),
		id = crypto.randomUUID();
	saved.connections.push({
		id: connectionId,
		name: "クラウド音声",
		baseUrl: "https://example.test/v1",
		enabled: true,
		epoch: 0,
		envRef: null,
	});
	saved.resources.push({
		id,
		connectionId,
		purpose: "tts",
		model: "multilingual",
		voice: "alloy",
		contextWindow: null,
	});
	saved.routes.tts.fallbackId = id;
	if (cloud) saved.routes.tts.mode = "cloud-only";
	const client = {
		identity: crypto.randomUUID(),
		settings: vi.fn(async () => saved),
		applySettings: vi.fn(async (input: ApplySettings) => {
			saved = settingsSchema.parse(input.settings);
			saved.revision++;
			return saved;
		}),
		larmVoices: vi.fn(async () => catalog),
		voiceSample: vi.fn(async () => new Uint8Array([1, 2, 3])),
	} as unknown as EumenesClient;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	cache.setQueryData([queryRoots.settings, client.identity], saved);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={cache}>
			<SettingsDraftProvider client={client}>{children}</SettingsDraftProvider>
		</QueryClientProvider>
	);
	return { client, wrapper, id };
}
function openVoice(f: ReturnType<typeof fixture>) {
	const onOpen = vi.fn();
	const view = render(
		<SettingsArtifact
			definition={settingsArtifactDefinition("voice")}
			onOpen={onOpen}
		/>,
		{ wrapper: f.wrapper },
	);
	return { ...view, onOpen };
}
test("capabilities, not model names, expose styles and ranges; changing character resets incompatible values", async () => {
	const f = fixture();
	openVoice(f);
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
	expect(screen.queryByText(/英語の声|英語の速さ|言語判定の接続先/)).toBeNull();
	fireEvent.change(screen.getByLabelText("キャラクター"), {
		target: { value: "simple" },
	});
	expect(screen.queryByLabelText("話し方（スタイル）")).toBeNull();
	expect(screen.queryByLabelText(/話す速さ/)).toBeNull();
	expect(screen.queryByLabelText(/抑揚/)).toBeNull();
});
test("cloud-only offers one TTS form without starting LARM or classifier calls", () => {
	const f = fixture(true);
	openVoice(f);
	expect(screen.getByLabelText(/の音声ID/)).toBeTruthy();
	expect(screen.queryByLabelText("キャラクター")).toBeNull();
	expect(screen.queryByRole("button", { name: "サンプルを再生" })).toBeNull();
	expect(f.client.larmVoices).not.toHaveBeenCalled();
});

test("voice and input can save their shared draft from any group without opening review", async () => {
	const f = fixture();
	const { onOpen } = openVoice(f);
	await screen.findByText(/サービスが対応する調整項目/);
	fireEvent.change(screen.getByLabelText(/^音量/), {
		target: { value: "0.55" },
	});
	for (const group of ["読み上げ", "聞き取り", "機器"]) {
		fireEvent.click(screen.getByRole("button", { name: group }));
		expect(
			screen.getByRole("button", { name: "設定の変更をすべて保存" }),
		).toHaveProperty("disabled", false);
	}
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて保存" }),
	);
	await screen.findByText("変更を適用しました");
	expect((await f.client.settings()).voice.outputVolume).toBe(0.55);
	expect(onOpen).not.toHaveBeenCalled();
	expect(
		screen.getByRole("button", { name: "設定の変更をすべて保存" }),
	).toHaveProperty("disabled", true);
});
test("input and cloud edits join the shared change review and save to existing fields", async () => {
	const f = fixture();
	const { onOpen, rerender } = openVoice(f);
	await screen.findByText(/サービスが対応する調整項目/);
	fireEvent.change(screen.getByLabelText("調整する読み上げ先"), {
		target: { value: f.id },
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
	expect(onOpen).toHaveBeenCalledWith("changes");
	rerender(
		<SettingsArtifact
			definition={settingsArtifactDefinition("changes")}
			onOpen={onOpen}
		/>,
	);
	expect(screen.getByText("音声と入力 / 利用する言語")).toBeTruthy();
	expect(
		screen.getByText("音声と入力 / クラウド音声 / multilingual の音声ID"),
	).toBeTruthy();
	expect(screen.queryByText("既存の設定画面の変更")).toBeNull();
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて適用" }),
	);
	await screen.findByText("変更を適用しました");
	const saved = await f.client.settings();
	expect(saved.general.asrLanguages).toEqual(["ja"]);
	expect(saved.voice.silenceMs).toBe(1800);
	expect(saved.resources[0]!.voice).toBe("nova");
	expect(saved.routes.tts.mode).toBe("larm-preferred");
});
test("source authorization rejects hidden capability fields, unknown devices, invalid language sets, limits", async () => {
	const f = fixture();
	const hook = renderHook(
		() => {
			const host = useSettingsDraft();
			return { host, voice: useVoiceSettings(host) };
		},
		{ wrapper: f.wrapper },
	);
	await waitFor(() =>
		expect(
			hook.result.current.voice.fields.some(
				(f) => f.id === "speech.local.speed",
			),
		).toBe(true),
	);
	const dispatch = (
		fieldId: string,
		value: string,
		source = "settings-voice-input",
	) => {
		const { host, voice } = hook.result.current;
		const event: ArtifactEvent = {
			id: crypto.randomUUID(),
			source,
			revision: host.current().revision,
			action: "settings-edit",
			values: { fieldId, value },
		};
		return settingsArtifactRuntime(host, vi.fn(), voice).dispatch(event);
	};
	for (const [id, value] of [
		["speech.local.speed", "1.4"],
		["input.silence-ms", "300.5"],
		["input.languages", "[]"],
		["input.languages", '["ja","ja"]'],
		["input.languages", '["unknown"]'],
		["input.device", "unlisted-device"],
		["speech.volume", "NaN"],
		["speech.volume", ""],
		["speech.enabled", "1"],
		["speech.local.voice", "unlisted"],
	]) {
		await act(async () =>
			expect(await dispatch(id!, value!)).toMatchObject({ status: "rejected" }),
		);
	}
	await act(async () =>
		expect(await dispatch("speech.local.voice", "simple")).toMatchObject({
			status: "accepted",
		}),
	);
	await act(async () =>
		expect(await dispatch("speech.local.speed", "1.1")).toMatchObject({
			status: "rejected",
		}),
	);
	await act(async () =>
		expect(
			await dispatch("speech.volume", ".5", "settings-conversation"),
		).toMatchObject({ status: "rejected" }),
	);
});
test("device permission is explicit and every acquired track stops, including late permission after closing", async () => {
	const f = fixture();
	let finish!: (stream: MediaStream) => void;
	const stop = vi.fn(),
		enumerate = vi.fn(async () => []);
	const getUserMedia = vi.fn(
		() =>
			new Promise<MediaStream>((resolve) => {
				finish = resolve;
			}),
	);
	vi.stubGlobal("navigator", {
		mediaDevices: { getUserMedia, enumerateDevices: enumerate },
	});
	const view = openVoice(f);
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
	const f = fixture();
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
	const hook = renderHook(
		() => {
			const host = useSettingsDraft();
			return { host, voice: useVoiceSettings(host) };
		},
		{ wrapper: f.wrapper },
	);
	await waitFor(() =>
		expect(
			hook.result.current.voice.fields.some(
				(f) => f.id === "speech.local.speed",
			),
		).toBe(true),
	);
	async function edit(fieldId: string, value: string) {
		const { host, voice } = hook.result.current;
		await act(async () =>
			expect(
				await settingsArtifactRuntime(host, vi.fn(), voice).dispatch({
					id: crypto.randomUUID(),
					source: "settings-voice-input",
					revision: host.current().revision,
					action: "settings-edit",
					values: { fieldId, value },
				}),
			).toMatchObject({ status: "accepted" }),
		);
	}
	await act(async () => hook.result.current.voice.action("devices-discover"));
	await waitFor(() =>
		expect(
			hook.result.current.voice.fields
				.find((f) => f.id === "input.device")
				?.options?.some((o) => o.value === "mic-test"),
		).toBe(true),
	);
	expect(stop).toHaveBeenCalledOnce();
	for (const [id, value] of [
		["speech.enabled", "false"],
		["speech.volume", ".7"],
		["speech.barge-in", "false"],
		["speech.local.voice", "female"],
		["speech.local.style", "bright"],
		["speech.local.speed", "1.1"],
		["speech.local.pitchScale", ".05"],
		["speech.local.intonationScale", "1.4"],
		["speech.local.autoIntonation", "true"],
		["speech.local.autoStrength", "1.5"],
		["input.languages", '["ja","fr"]'],
		["input.threshold", ".012"],
		["input.silence-ms", "2100"],
		["input.echo", "false"],
		["input.noise", "false"],
		["input.gain", "false"],
		["input.device", "mic-test"],
		["output.device", "speaker-test"],
		["speech.target", f.id],
		["speech.cloud." + f.id + ".voice", "nova"],
		["speech.cloud." + f.id + ".speed", "1.2"],
	])
		await edit(id!, value!);
	const rows = settingsArtifactRuntime(hook.result.current.host, vi.fn())
		.snapshot["settings-changes"];
	expect(
		rows?.kind === "settings-changes" &&
			rows.rows.some((r) => r.id === "legacy"),
	).toBe(false);
	await act(async () => {
		expect(await hook.result.current.host.apply()).not.toBeNull();
	});
	const saved = await f.client.settings();
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
	expect(saved.general.asrLanguages).toEqual(["ja", "fr"]);
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
	await edit("speech.volume", ".9");
	act(() => hook.result.current.host.discard());
	expect(hook.result.current.host.value?.voice.outputVolume).toBe(0.7);
});

test("voice actions refresh the catalog, cancel playback and dispatch every legacy destination", async () => {
	const f = fixture();
	let finish!: (v: Awaited<ReturnType<EumenesClient["voiceSample"]>>) => void;
	vi.mocked(f.client.voiceSample).mockImplementationOnce(
		(_voice, _signal) =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const hook = renderHook(
		() => {
			const host = useSettingsDraft();
			return { host, voice: useVoiceSettings(host) };
		},
		{ wrapper: f.wrapper },
	);
	await waitFor(() =>
		expect(
			hook.result.current.voice.actions.find((a) => a.id === "voice-sample")
				?.disabled,
		).toBe(false),
	);
	await act(async () => hook.result.current.voice.action("voice-sample"));
	expect(
		hook.result.current.voice.actions.find((a) => a.id === "voice-sample")
			?.label,
	).toBe("サンプルの準備を取消");
	const signal = vi.mocked(f.client.voiceSample).mock.calls[0]![1]!;
	await act(async () => hook.result.current.voice.action("voice-sample"));
	expect(signal.aborted).toBe(true);
	await act(async () => finish(new Uint8Array([1])));
	expect(
		hook.result.current.voice.actions.find((a) => a.id === "voice-sample")
			?.label,
	).toBe("サンプルを再生");
	const calls = vi.mocked(f.client.larmVoices).mock.calls.length;
	await act(async () => hook.result.current.voice.action("voice-refresh"));
	await waitFor(() =>
		expect(vi.mocked(f.client.larmVoices).mock.calls.length).toBeGreaterThan(
			calls,
		),
	);
	for (const [id, target] of [
		["voice-routing", "ai"],
		["input-routing", "ai"],
		["voice-register", "connections"],
		["voice-dictionary", "dictionary"],
	]) {
		act(() => hook.result.current.voice.action(id!));
		expect(window.location.hash).toBe("#settings/" + target);
	}
	act(() => {
		expect(hook.result.current.voice.edit("speech.target", f.id)).toBe(true);
	});
	act(() => hook.result.current.voice.action("voice-trial"));
	expect(window.location.hash).toBe("#settings/services");
	window.location.hash = "";
});
