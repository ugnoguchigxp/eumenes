import {
	act,
	cleanup,
	render,
	renderHook,
	screen,
	fireEvent,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { EumenesClient } from "../../../../client";
import type {
	LiveEvent,
	LiveSnapshot,
} from "../../../../api/domains/live-voice/contracts";
import { settingsSchema } from "../../../../api/domains/settings/contracts";
function settingsFixture() {
	const route = () => ({
		mode: "larm-preferred",
		cloudAllowed: false,
		fallbackId: null,
		epoch: 0,
	});
	return settingsSchema.parse({
		revision: 1,
		larm: { baseUrl: null, audience: "same-host", voice: "" },
		connections: [],
		resources: [],
		routes: {
			llm: route(),
			asr: route(),
			tts: { ...route(), mode: "larm-only" },
		},
		voice: {
			autoSpeak: true,
			bargeIn: true,
			inputDevice: "",
			outputDevice: "",
			threshold: 0.008,
			silenceMs: 1500,
			echoCancellation: true,
			noiseSuppression: true,
			autoGainControl: true,
		},
		general: { theme: "system" },
	});
}
const fake = vi.hoisted(() => ({
	create: vi.fn(),
	close: vi.fn(),
	mute: vi.fn(),
	play: vi.fn(),
}));
vi.mock("../audio", () => ({ createLivePcm: fake.create }));
import { useLiveVoice } from "./useLiveVoice";
import { LiveVoicePanel } from "./LiveVoicePanel";
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});
const snapshot: LiveSnapshot = {
	id: "s",
	conversationId: "main",
	status: "connecting",
	muted: false,
	test: false,
	startedAt: "2026-10-31T00:00:00Z",
	error: null,
	usageConfirmed: false,
	segments: [],
	notices: [],
};
function fixture() {
	let controller: ReadableStreamDefaultController<Uint8Array>;
	let current = { ...snapshot };
	const emit = (event: LiveEvent) =>
		controller.enqueue(
			new TextEncoder().encode(
				`event: live\ndata: ${JSON.stringify(event)}\n\n`,
			),
		);
	fake.create.mockResolvedValue({
		close: fake.close,
		mute: fake.mute,
		play: fake.play,
	});
	const methods = {
		identity: crypto.randomUUID(),
		liveCurrent: vi.fn(async () => null),
		liveStart: vi.fn(async () => current),
		liveAudio: vi.fn(
			async (
				_id: string,
				_sequence: number,
				_audio: string,
				_signal?: AbortSignal,
			) => {},
		),
		liveMute: vi.fn(async () => {}),
		liveDisplayed: vi.fn(async () => {}),
		liveStream: vi.fn(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(c) {
							controller = c;
						},
					}),
				),
		),
		liveStop: vi.fn(async () => {
			current = { ...current, status: "closed" };
			return current;
		}),
	};
	const client = methods as unknown as EumenesClient;
	const settings = settingsFixture();
	settings.live = {
		enabled: true,
		cloudAllowed: true,
		connectionId: "connection",
		model: "fixture-voice",
		voice: "",
		startWithMicrophone: true,
		instructions: "",
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	return {
		methods,
		client,
		settings,
		wrapper,
		emit,
		state: (next: Partial<LiveSnapshot>) => {
			current = { ...current, ...next };
			emit({ type: "state", state: current });
		},
		audio: () =>
			fake.create.mock.calls[0]![0] as { onInput: (s: string) => void },
	};
}
test("the actual hook sequences raw audio, plays output, shares status with settings and releases resources", async () => {
	const f = fixture();
	const before = vi.fn(async () => {});
	const h = renderHook(
		() => ({
			main: useLiveVoice(f.client, f.settings, before),
			settings: useLiveVoice(f.client, f.settings, undefined, false),
		}),
		{ wrapper: f.wrapper },
	);
	await act(() => h.result.current.main.start());
	expect(before).toHaveBeenCalledOnce();
	await waitFor(() => expect(f.methods.liveStream).toHaveBeenCalledOnce());
	await act(() => f.state({ status: "active" }));
	expect(h.result.current.settings.active).toBe(true);
	await act(() => {
		f.audio().onInput("AAAAAA==");
		f.audio().onInput("AAAAAA==");
	});
	await waitFor(() => expect(f.methods.liveAudio).toHaveBeenCalledTimes(2));
	expect(f.methods.liveAudio.mock.calls.map((call) => call[1])).toEqual([1, 2]);
	await act(() => f.emit({ type: "audio", sequence: 1, audio: "AAAAAA==" }));
	expect(fake.play).toHaveBeenCalledWith("AAAAAA==");
	await act(() => h.result.current.main.mute());
	expect(fake.mute).toHaveBeenLastCalledWith(true);
	expect(f.methods.liveMute).toHaveBeenCalledWith("s", true);
	await act(() => h.result.current.main.stop());
	expect(fake.close).toHaveBeenCalled();
	expect(h.result.current.settings.active).toBe(false);
});

test("stopping cancels queued microphone sends and waits for the final state", async () => {
	const f = fixture();
	const upload = Promise.withResolvers<void>();
	const stop = Promise.withResolvers<LiveSnapshot>();
	f.methods.liveAudio.mockImplementationOnce(() => upload.promise);
	f.methods.liveStop.mockImplementationOnce(() => stop.promise);
	const h = renderHook(() => useLiveVoice(f.client, f.settings), {
		wrapper: f.wrapper,
	});
	await act(() => h.result.current.start());
	await act(() => f.state({ status: "active" }));
	await act(() => {
		f.audio().onInput("AAA=");
		f.audio().onInput("AQA=");
	});
	await waitFor(() => expect(f.methods.liveAudio).toHaveBeenCalledOnce());
	const signal = f.methods.liveAudio.mock.calls[0]![3];

	let stopping: Promise<void> | undefined;
	await act(() => {
		stopping = h.result.current.stop();
	});
	await act(async () => {
		upload.reject(new Error("live_session_inactive"));
		await upload.promise.catch(() => {});
	});
	expect(f.methods.liveAudio).toHaveBeenCalledOnce();
	expect(signal?.aborted).toBe(true);
	expect(f.methods.liveStop).toHaveBeenCalledOnce();
	expect(h.result.current.error).toBeNull();
	await act(() => f.state({ status: "closing" }));
	await waitFor(() => expect(h.result.current.session?.status).toBe("closing"));
	await act(() => f.state({ status: "closed", usageConfirmed: true }));
	await waitFor(() => expect(h.result.current.session?.status).toBe("closed"));
	await act(async () => {
		stop.resolve({ ...snapshot, status: "closing" });
		await stopping;
	});
	expect(h.result.current.session?.usageConfirmed).toBe(true);
	expect(h.result.current.active).toBe(false);
});

test("a brief upload delay drains waiting PCM in order without stopping the session", async () => {
	const f = fixture();
	const first = Promise.withResolvers<void>();
	const second = Promise.withResolvers<void>();
	f.methods.liveAudio
		.mockImplementationOnce(() => first.promise)
		.mockImplementationOnce(() => second.promise);
	const h = renderHook(() => useLiveVoice(f.client, f.settings), {
		wrapper: f.wrapper,
	});
	await act(() => h.result.current.start());
	await act(() => f.state({ status: "active" }));
	const frames = Array.from({ length: 30 }, (_, i) =>
		String.fromCharCode(i, 0),
	);
	const submit = (from: number, to: number) => {
		for (const frame of frames.slice(from, to)) f.audio().onInput(btoa(frame));
	};
	await act(() => submit(0, 20));
	await waitFor(() => expect(f.methods.liveAudio).toHaveBeenCalledOnce());
	await act(async () => first.resolve());
	await waitFor(() => expect(f.methods.liveAudio).toHaveBeenCalledTimes(2));
	await act(() => submit(20, 30));
	expect(f.methods.liveStop).not.toHaveBeenCalled();
	expect(h.result.current.error).toBeNull();
	expect(atob(f.methods.liveAudio.mock.calls[1]![2])).toBe(
		frames.slice(1, 20).join(""),
	);
	await act(async () => second.resolve());
	await waitFor(() => expect(f.methods.liveAudio).toHaveBeenCalledTimes(3));
	expect(atob(f.methods.liveAudio.mock.calls[2]![2])).toBe(
		frames.slice(20).join(""),
	);
	expect(f.methods.liveAudio.mock.calls.map((call) => call[1])).toEqual([
		1, 2, 3,
	]);
});

test("waiting PCM is sent in packets within the backend limit", async () => {
	const f = fixture();
	const first = Promise.withResolvers<void>();
	f.methods.liveAudio.mockImplementationOnce(() => first.promise);
	const h = renderHook(() => useLiveVoice(f.client, f.settings), {
		wrapper: f.wrapper,
	});
	await act(() => h.result.current.start());
	await act(() => f.state({ status: "active" }));
	const frames = [1, 2, 3].map((sample) =>
		String.fromCharCode(sample, 0).repeat(6000),
	);
	await act(() => {
		f.audio().onInput("AAA=");
		for (const frame of frames) f.audio().onInput(btoa(frame));
	});
	await waitFor(() => expect(f.methods.liveAudio).toHaveBeenCalledOnce());
	await act(async () => first.resolve());
	await waitFor(() => expect(f.methods.liveAudio).toHaveBeenCalledTimes(3));
	expect(
		f.methods.liveAudio.mock.calls.slice(1).map((call) => atob(call[2])),
	).toEqual([frames[0]! + frames[1]!, frames[2]]);
});
test("a session refused by the provider closes the already granted microphone", async () => {
	const f = fixture();
	f.methods.liveStart.mockResolvedValueOnce({
		...snapshot,
		status: "failed",
		error: "live_connect_failed",
	});
	const h = renderHook(() => useLiveVoice(f.client, f.settings), {
		wrapper: f.wrapper,
	});
	await act(() => h.result.current.start());
	expect(h.result.current.active).toBe(false);
	expect(fake.close).toHaveBeenCalled();
	expect(h.result.current.error).toContain("接続できません");
	expect(f.methods.liveStream).not.toHaveBeenCalled();
});
test("live subtitles display the configured agent name before they enter history", async () => {
	const f = fixture();
	f.settings.general.agentName = "光";
	function View() {
		const live = useLiveVoice(f.client, f.settings);
		return (
			<>
				<button onClick={() => void live.start()}>開始</button>
				<LiveVoicePanel live={live} agentName={f.settings.general.agentName} />
			</>
		);
	}
	render(<View />, { wrapper: f.wrapper });
	await act(async () => {
		fireEvent.click(screen.getByText("開始"));
	});
	await waitFor(() => expect(f.methods.liveStream).toHaveBeenCalledOnce());
	await act(() =>
		f.state({
			status: "active",
			segments: [
				{
					id: "answer",
					speaker: "assistant",
					text: "お聞きしています。",
					startMs: 0,
					endMs: 100,
					messageId: null,
				},
			],
		}),
	);
	expect(await screen.findByText("光 · 文字起こし")).toBeTruthy();
	expect(screen.queryByText("Eumenes · 文字起こし")).toBeNull();
	expect(screen.getByText("お聞きしています。")).toBeTruthy();
});
