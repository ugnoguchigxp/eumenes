import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { expect, test, vi } from "vitest";
import { ApiConnectionError, ApiError } from "../../../../../client/transport";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import {
	createAudioStore,
	type CreateAudio,
	type AudioController,
} from "../../audio";
import { useVoiceDialogue } from "..";
import { inputClientFixture } from "./input-client.fixture";

function playback(
	fault: "audio" | "report" | "both",
	error: Error = new ApiConnectionError(),
	holdSecondAudio = false,
) {
	const query = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={query}>{children}</QueryClientProvider>
	);
	let segment = (_wav: Uint8Array) => {};
	let sessionId = "";
	const failure = Promise.withResolvers<never>();
	const started: number[] = [];
	const endings: (() => void)[] = [];
	let release = () => {};
	let previous = Promise.resolve();
	const stop = vi.fn(async () => release());
	const createAudio: CreateAudio = (_store, _speech, onSegment) => {
		segment = onSegment;
		return {
			start: async () => {},
			stop,
			stopPlayback: () => release(),
			play: async (bytes, ended, options) => {
				if (options?.waitForPrevious) await previous;
				if (options?.shouldPlay?.() === false) return;
				const done = Promise.withResolvers<void>();
				previous = done.promise;
				release = done.resolve;
				started.push(bytes[0]!);
				options?.onStarted?.();
				endings.push(() => {
					done.resolve();
					ended?.();
				});
			},
		} satisfies AudioController;
	};
	let audioFailed = false;
	const voiceAudio = vi.fn(
		async (_id: string, index: number, signal?: AbortSignal) => {
			if (index === 1) {
				if (holdSecondAudio)
					return new Promise<never>((_, reject) => {
						signal?.addEventListener("abort", () => reject(signal.reason), {
							once: true,
						});
					});
				if (fault !== "report" && !audioFailed) {
					audioFailed = true;
					await failure.promise;
				}
			}
			return new Uint8Array([index]);
		},
	);
	let reportFailed = false;
	const voicePlayed = vi.fn(
		async (
			_id: string,
			index: number,
			_gap?: unknown,
			_signal?: AbortSignal,
		) => {
			if (fault !== "audio" && index === 0 && !reportFailed) {
				reportFailed = true;
				await failure.promise;
			}
			return {};
		},
	);
	const voiceCancel = vi.fn(async () => ({}));
	const client = inputClientFixture({
		identity: "speech-transport",
		voiceStart: async (id: string) => {
			sessionId = id;
		},
		voiceStop: async () => {},
		voiceSend: async () => {},
		voiceAudio,
		voicePlayed,
		voiceCancel,
		voiceTurn: async (utteranceId: string) => ({
			utteranceId,
			sessionId,
			generation: 1,
			sequence: 1,
			runId: "run",
			status: "responding",
			text: "依頼",
			error: null,
			revision: 1,
			audioGeneration: 1,
			audioChunks: [
				{ index: 0, text: "一。" },
				{ index: 1, text: "二。" },
			],
		}),
	} as unknown as VoiceDialogueClient);
	const store = createAudioStore();
	const hook = renderHook(() => useVoiceDialogue(client, store, createAudio), {
		wrapper,
	});
	return {
		hook,
		started,
		endings,
		voiceAudio,
		voicePlayed,
		voiceCancel,
		stop,
		async begin() {
			await act(async () => hook.result.current.start());
			act(() => segment(new Uint8Array(44)));
			await waitFor(() => expect(started).toEqual([0]));
		},
		async fail() {
			await act(async () => failure.reject(error));
		},
		close() {
			hook.unmount();
			query.clear();
		},
	};
}

test.each(["audio", "report", "both"] as const)(
	"one failure at %s still plays each clause once in order",
	async (fault) => {
		const f = playback(fault);
		try {
			await f.begin();
			await act(async () => f.endings[0]!());
			await f.fail();
			await waitFor(() => expect(f.started).toEqual([0, 1]));
			await act(async () => f.endings[1]!());
			await waitFor(() => {
				expect(f.voiceAudio.mock.calls.map(([, i]) => i)).toEqual(
					fault !== "report" ? [0, 1, 1] : [0, 1],
				);
				expect(f.voicePlayed.mock.calls.map(([, i]) => i).sort()).toEqual(
					fault !== "audio" ? [0, 0, 1] : [0, 1],
				);
			});
			expect(f.started).toEqual([0, 1]);
			expect(f.voiceCancel).not.toHaveBeenCalled();
			expect(f.hook.result.current.failure).toBeNull();
		} finally {
			f.close();
		}
	},
);

test.each(["audio", "report"] as const)(
	"explicit stop drops pending playback and the scheduled %s retry",
	async (fault) => {
		const f = playback(fault, undefined, fault === "report");
		try {
			await f.begin();
			if (fault === "report") await act(async () => f.endings[0]!());
			await f.fail();
			await act(async () => f.hook.result.current.stop());
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 350));
			});
			expect(f.started).toEqual([0]);
			expect(f.stop).toHaveBeenCalledTimes(1);
			expect(f.voiceAudio).toHaveBeenCalledTimes(2);
			expect(f.voiceAudio.mock.calls[1]?.[2]?.aborted).toBe(true);
			expect(f.voicePlayed).toHaveBeenCalledTimes(fault === "report" ? 1 : 0);
			if (fault === "report")
				expect(f.voicePlayed.mock.calls[0]?.[3]?.aborted).toBe(true);
			expect(f.voiceCancel).not.toHaveBeenCalled();
		} finally {
			f.close();
		}
	},
);

test("a revoked audio request is not retried", async () => {
	const f = playback("audio", new ApiError(403, "playback_forbidden"));
	try {
		await f.begin();
		await act(async () => f.endings[0]!());
		await f.fail();
		await waitFor(() => expect(f.voiceCancel).toHaveBeenCalledTimes(1));
		expect(f.voiceAudio).toHaveBeenCalledTimes(2);
		expect(f.started).toEqual([0]);
	} finally {
		f.close();
	}
});
