import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { expect, test, vi } from "vitest";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import { createAudioStore, type CreateAudio } from "../../audio";
import { useVoiceDialogue } from "..";

function harness(send: (...args: unknown[]) => Promise<unknown>) {
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	const microphones: Array<(wav: Uint8Array) => void> = [];
	let notice: (reason: "recording_limit") => void = () => {};
	const start = vi.fn(async () => {}),
		pauseInput = vi.fn(),
		voiceStart = vi.fn(async () => ({})),
		voiceStop = vi.fn(async () => ({}));
	const createAudio: CreateAudio = (_state, _speech, segment, options) => {
		microphones.push(segment);
		notice = (reason) => options?.onNotice?.(reason);
		return {
			start,
			pauseInput,
			stop: async () => {},
			stopPlayback() {},
			play: async () => {},
		};
	};
	const voiceSend = vi.fn(send);
	const client = {
		identity: "capture-regression",
		voiceStart,
		voiceStop,
		voiceSend,
		voiceTurn: async (id: string) => ({
			utteranceId: id,
			status: "completed",
			text: "",
			error: null,
		}),
		voiceCancel: async () => ({}),
	} as unknown as VoiceDialogueClient;
	const hook = renderHook(
		() => useVoiceDialogue(client, createAudioStore(), createAudio),
		{ wrapper },
	);
	return {
		hook,
		start,
		pauseInput,
		voiceStart,
		voiceStop,
		voiceSend,
		segment: () => microphones.at(-1)!(new Uint8Array(44)),
		notice: () => notice("recording_limit"),
		done: () => {
			hook.unmount();
			cache.clear();
		},
	};
}

test("backpressure retains the final recording and pauses capture until all queued uploads can finish", async () => {
	let release!: () => void;
	const first = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	const h = harness(async () => {
		if (++calls === 1) await first;
		return {};
	});
	try {
		await act(async () => h.hook.result.current.start());
		act(() => {
			h.segment();
			h.segment();
			h.segment();
			h.segment(); // Frames delivered after the pause cannot grow the queue.
		});
		await waitFor(() => expect(h.voiceSend).toHaveBeenCalledTimes(1));
		expect(h.hook.result.current.active).toBe(false);
		expect(h.pauseInput).toHaveBeenCalledTimes(1);
		await act(async () => h.hook.result.current.start());
		expect(h.start).toHaveBeenCalledTimes(1);
		await act(async () => release());
		await waitFor(() => expect(h.voiceSend).toHaveBeenCalledTimes(3));
		expect(h.voiceSend.mock.calls.map((args) => args[2])).toEqual([1, 2, 3]);
		await act(async () => h.hook.result.current.start());
		expect(h.start).toHaveBeenCalledTimes(2);
		expect(h.voiceStart).toHaveBeenCalledTimes(1);
	} finally {
		h.done();
	}
});

test("the recording limit pauses the visible microphone and lets the same session resume", async () => {
	const h = harness(async () => ({}));
	try {
		await act(async () => h.hook.result.current.start());
		act(() => {
			h.segment();
			h.notice();
		});
		await waitFor(() => expect(h.voiceSend).toHaveBeenCalledTimes(1));
		expect(h.hook.result.current.active).toBe(false);
		expect(h.hook.result.current.error).toContain("60秒");
		await act(async () => h.hook.result.current.start());
		expect(h.hook.result.current.active).toBe(true);
		expect(h.hook.result.current.error).toBeNull();
		expect(h.voiceStart).toHaveBeenCalledTimes(1);
	} finally {
		h.done();
	}
});

test("a capture pause during startup cannot be overwritten by the late startup completion", async () => {
	const h = harness(async () => ({}));
	h.start.mockImplementationOnce(async () => {
		h.notice();
	});
	try {
		await act(async () => h.hook.result.current.start());
		expect(h.hook.result.current.active).toBe(false);
		await act(async () => h.hook.result.current.start());
		expect(h.hook.result.current.active).toBe(true);
		expect(h.start).toHaveBeenCalledTimes(2);
	} finally {
		h.done();
	}
});

test("an upload failure pauses the mic and an explicit restart opens a usable new session", async () => {
	let fail = true;
	const h = harness(async () => {
		if (fail) throw new Error("upload_rejected");
		return {};
	});
	try {
		await act(async () => h.hook.result.current.start());
		act(() => h.segment());
		await waitFor(() =>
			expect(h.hook.result.current.error).toContain("upload_rejected"),
		);
		expect(h.hook.result.current.active).toBe(false);
		fail = false;
		await act(async () => h.hook.result.current.start());
		expect(h.voiceStart).toHaveBeenCalledTimes(2);
		expect(h.voiceStop).toHaveBeenCalledTimes(1);
		act(() => h.segment());
		await waitFor(() => expect(h.voiceSend).toHaveBeenCalledTimes(2));
		expect(h.voiceSend.mock.calls[1]![2]).toBe(1);
		expect(h.voiceSend.mock.calls[1]![0]).not.toBe(
			h.voiceSend.mock.calls[0]![0],
		);
	} finally {
		h.done();
	}
});
