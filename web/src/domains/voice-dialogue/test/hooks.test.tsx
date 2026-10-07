import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { expect, test, vi } from "vitest";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import {
	createAudioController,
	createAudioStore,
	type AudioController,
} from "../../audio";
import { useVoiceDialogue } from "..";

test("speech interruption prevents a fetched old answer from starting playback", async () => {
	const query = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={query}>{children}</QueryClientProvider>
	);
	let speech = () => {};
	let segment = (_wav: Uint8Array) => {};
	const play = vi.fn(async () => {});
	const createAudio = (
		_onState: Parameters<typeof createAudioController>[0],
		onSpeech: () => void,
		onSegment: (wav: Uint8Array) => void,
	): AudioController => {
		speech = onSpeech;
		segment = onSegment;
		return {
			start: async () => {},
			stop: async () => {},
			stopPlayback: () => {},
			play,
		};
	};
	let sessionId = "";
	let utteranceId = "";
	let resolveAudio: ((wav: Uint8Array) => void) | undefined;
	const voiceAudio = vi.fn(
		() =>
			new Promise<Uint8Array>((resolve) => {
				resolveAudio = resolve;
			}),
	);
	const client = {
		identity: "http://127.0.0.1:8787",
		voiceStart: async (id: string) => {
			sessionId = id;
			return { sessionId: id, generation: 1 };
		},
		voiceStop: async () => ({ stopped: true }),
		voiceSend: async (
			_session: string,
			_generation: number,
			_sequence: number,
			id: string,
		) => {
			utteranceId = id;
			return { utteranceId: id };
		},
		voiceTurn: async (id: string) => ({
			utteranceId: id,
			sessionId,
			generation: 1,
			sequence: 1,
			status: "ready",
			text: "質問",
			runId: "run",
			error: null,
			revision: 3,
		}),
		voiceAudio,
		voicePlayed: async () => ({}),
		voiceCancel: async () => ({}),
	} as unknown as VoiceDialogueClient;
	const store = createAudioStore();
	const hook = renderHook(() => useVoiceDialogue(client, store, createAudio), {
		wrapper,
	});
	await act(async () => hook.result.current.start());
	act(() => segment(new Uint8Array(44)));
	await waitFor(() => expect(voiceAudio).toHaveBeenCalledWith(utteranceId));
	act(() => speech());
	await act(async () => {
		resolveAudio?.(new Uint8Array(44));
		await Promise.resolve();
	});
	expect(play).not.toHaveBeenCalled();
	hook.unmount();
	query.clear();
});

test("stopping during session creation prevents a late microphone start", async () => {
	const query = new QueryClient();
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={query}>{children}</QueryClientProvider>
	);
	let resolveStart: (() => void) | undefined;
	const voiceStart = vi.fn(
		() =>
			new Promise<{ sessionId: string; generation: number }>((resolve) => {
				resolveStart = () => resolve({ sessionId: "started", generation: 1 });
			}),
	);
	const voiceStop = vi.fn(async () => ({ stopped: true }));
	const client = {
		identity: "http://127.0.0.1:8787",
		voiceStart,
		voiceStop,
	} as unknown as VoiceDialogueClient;
	const createAudio = vi.fn(() => ({
		start: async () => {},
		stop: async () => {},
		stopPlayback: () => {},
		play: async () => {},
	})) as unknown as typeof createAudioController;
	const hook = renderHook(
		() => useVoiceDialogue(client, createAudioStore(), createAudio),
		{ wrapper },
	);
	let startPromise: Promise<void> | undefined;
	act(() => {
		startPromise = hook.result.current.start();
		void hook.result.current.start();
	});
	expect(voiceStart).toHaveBeenCalledTimes(1);
	await act(async () => hook.result.current.stop());
	await act(async () => {
		resolveStart?.();
		await startPromise;
	});
	expect(voiceStop).toHaveBeenCalledTimes(1);
	expect(createAudio).not.toHaveBeenCalled();
	expect(hook.result.current.active).toBe(false);
	hook.unmount();
	query.clear();
});
