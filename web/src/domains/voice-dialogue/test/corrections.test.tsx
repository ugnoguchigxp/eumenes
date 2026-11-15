import { inputClientFixture } from "./input-client.fixture";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { expect, test, vi } from "vitest";
import type { VoiceTurn } from "../../../../../api/domains/voice-dialogue/contracts";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import { createAudioStore, type CreateAudio } from "../../audio";
import { useVoiceDialogue } from "..";

function setup() {
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: PropsWithChildren) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	let speech = () => {},
		segment = (_wav: Uint8Array) => {};
	let sessionId = "",
		busy = false;
	const turns = new Map<string, VoiceTurn>();
	const ids: string[] = [];
	const listeners = new Map<string, (turn: VoiceTurn) => void>();
	const disconnects = new Map<string, (error: Error) => void>();
	const voiceCancel = vi.fn(async () => {});
	const stopPlayback = vi.fn();
	const voiceCommit = vi.fn(async (id: string) => {
		const turn = turns.get(id)!;
		turn.status = "responding";
		turn.runId = "accepted-run";
		return turn;
	});
	const reads = vi.fn(async (id: string) => ({ ...turns.get(id)! }));
	const client = inputClientFixture({
		identity: "correction-test",
		watchVoiceInput: (
			id: string,
			signal: AbortSignal,
			receive: (turn: VoiceTurn) => void,
		) =>
			new Promise<void>((resolve, reject) => {
				disconnects.set(id, reject);
				listeners.set(id, receive);
				signal.addEventListener(
					"abort",
					() => {
						listeners.delete(id);
						resolve();
					},
					{ once: true },
				);
			}),
		voiceStart: async (id: string) => {
			sessionId = id;
		},
		voiceStop: async () => {},
		voiceCancel,
		voiceSend: async (
			_s: string,
			generation: number,
			sequence: number,
			id: string,
		) => {
			ids.push(id);
			turns.set(id, {
				utteranceId: id,
				sessionId,
				generation,
				sequence,
				revision: 0,
				status: "recognizing",
				text: null,
				runId: null,
				error: null,
			});
			return turns.get(id)!;
		},
		voiceTurn: reads,
		voiceCommit,
	} as unknown as VoiceDialogueClient);
	const createAudio: CreateAudio = (_state, onSpeech, onSegment) => {
		speech = () => {
			busy = true;
			onSpeech();
		};
		segment = (wav) => {
			busy = false;
			onSegment(wav);
		};
		return {
			start: async () => {},
			stop: async () => {},
			pauseInput() {},
			stopPlayback,
			play: async () => {},
			isInputBusy: () => busy,
		};
	};
	const hook = renderHook(
		() => useVoiceDialogue(client, createAudioStore(), createAudio),
		{ wrapper },
	);
	return {
		hook,
		ids,
		voiceCommit,
		voiceCancel,
		stopPlayback,
		reads,
		refresh: () => cache.invalidateQueries(),
		disconnect: async (index: number, patch: Partial<VoiceTurn>) => {
			await waitFor(() => expect(disconnects.has(ids[index]!)).toBe(true));
			Object.assign(turns.get(ids[index]!)!, patch);
			await act(async () =>
				disconnects.get(ids[index]!)!(new Error("disconnected")),
			);
		},
		speech: () => act(() => speech()),
		segment: () => act(() => segment(new Uint8Array(44))),
		update: async (index: number, patch: Partial<VoiceTurn>) => {
			const id = ids[index]!;
			await waitFor(() => expect(listeners.has(id)).toBe(true));
			Object.assign(turns.get(id)!, patch);
			await act(async () => listeners.get(id)!({ ...turns.get(id)! }));
		},
		done: () => {
			hook.unmount();
			cache.clear();
		},
	};
}

test("resumed speech keeps the accepted pending input and commits the combined result once", async () => {
	const h = setup();
	try {
		await act(async () => h.hook.result.current.start());
		h.speech();
		h.segment();
		await waitFor(() => expect(h.ids).toHaveLength(1));
		// The speaker resumes before the first transcript arrives, so it is not sent yet.
		h.speech();
		await h.update(0, {
			text: "明日の予定を",
			status: "input_ready",
			revision: 2,
		});
		await waitFor(() =>
			expect(h.hook.result.current.transcription?.text).toBe("明日の予定を"),
		);
		const expected = "明日の予定を\nいえ、来週の予定を教えて";
		h.segment();
		await waitFor(() => expect(h.ids).toHaveLength(2));
		expect(h.hook.result.current.transcription?.text).toBe("明日の予定を");
		expect(h.voiceCommit).not.toHaveBeenCalled();
		await h.update(1, { text: expected, status: "input_ready", revision: 2 });
		await waitFor(() =>
			expect(h.voiceCommit).toHaveBeenCalledExactlyOnceWith(
				h.ids[1],
				2,
				undefined,
				undefined,
			),
		);
		expect(h.hook.result.current.transcription?.text).toBe(expected);
		h.speech();
		expect(h.hook.result.current.inputStatus).toBe("capturing");
		expect(h.hook.result.current.transcription).toBeNull();
	} finally {
		h.done();
	}
});

test("a failed transcription reports its error and is never committed", async () => {
	const h = setup();
	try {
		await act(async () => h.hook.result.current.start());
		h.speech();
		h.segment();
		await waitFor(() => expect(h.ids).toHaveLength(1));
		await h.update(0, {
			status: "failed",
			error: "voice_input_capacity",
			revision: 2,
		});
		await waitFor(() =>
			expect(h.hook.result.current.error).toContain("文字起こしが長く"),
		);
		expect(h.voiceCommit).not.toHaveBeenCalled();
	} finally {
		h.done();
	}
});

test("editing takes the input away from automatic send without interrupting output", async () => {
	const h = setup();
	try {
		await act(async () => h.hook.result.current.start());
		h.speech();
		h.segment();
		await waitFor(() => expect(h.ids).toHaveLength(1));
		await act(async () => h.hook.result.current.takeInputOwnership());
		await h.update(0, {
			status: "input_ready",
			text: "編集前の認識",
			revision: 2,
		});
		expect(h.voiceCommit).not.toHaveBeenCalled();
		expect(h.hook.result.current.transcription).toBeNull();
		expect(h.hook.result.current.active).toBe(false);
		expect(h.hook.result.current.inputHold).toBe("edited");
		expect(h.stopPlayback).not.toHaveBeenCalled();
		expect(h.voiceCancel).toHaveBeenCalledWith(h.ids[0]);
	} finally {
		h.done();
	}
});

test("editing an unsubmitted recording does not request a nonexistent turn", async () => {
	const h = setup();
	try {
		await act(async () => h.hook.result.current.start());
		h.speech();
		await act(async () => h.hook.result.current.takeInputOwnership());
		expect(h.ids).toHaveLength(0);
		expect(h.reads).not.toHaveBeenCalled();
		expect(h.voiceCancel).not.toHaveBeenCalled();
		expect(h.hook.result.current.error).toBeNull();
		expect(h.hook.result.current.inputHold).toBe("edited");
	} finally {
		h.done();
	}
});

test("recognition bypasses global refetches and delivers accepted text directly", async () => {
	const h = setup();
	try {
		await act(async () => h.hook.result.current.start());
		h.speech();
		h.segment();
		await waitFor(() => expect(h.ids).toHaveLength(1));
		act(() => h.hook.result.current.pause());
		await act(async () => h.refresh());
		await h.update(0, {
			status: "input_ready",
			text: "通知から届いた入力",
			revision: 2,
		});
		await waitFor(() =>
			expect(h.hook.result.current.transcription?.text).toBe(
				"通知から届いた入力",
			),
		);
		expect(h.reads).not.toHaveBeenCalled();
		expect(h.hook.result.current.inputStatus).toBe("ready");
		expect(h.voiceCommit).not.toHaveBeenCalled();
	} finally {
		h.done();
	}
});

test("a result recovered after disconnection is a draft, never an automatic message", async () => {
	const h = setup();
	try {
		await act(async () => h.hook.result.current.start());
		h.speech();
		h.segment();
		await waitFor(() => expect(h.ids).toHaveLength(1));
		await h.disconnect(0, {
			status: "input_ready",
			text: "復旧後の入力",
			revision: 2,
		});
		await waitFor(() =>
			expect(h.hook.result.current.transcription?.text).toBe("復旧後の入力"),
		);
		expect(h.hook.result.current.inputHold).toBe("disconnected");
		expect(h.voiceCommit).not.toHaveBeenCalled();
	} finally {
		h.done();
	}
});

test("late recognition stays visible without a surprise automatic send", async () => {
	let now = 0;
	const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
	const h = setup();
	try {
		await act(async () => h.hook.result.current.start());
		h.speech();
		h.segment();
		await waitFor(() => expect(h.ids).toHaveLength(1));
		now = 10_001;
		await h.update(0, {
			status: "input_ready",
			text: "遅れて届いた入力",
			revision: 2,
		});
		await waitFor(() =>
			expect(h.hook.result.current.transcription?.text).toBe(
				"遅れて届いた入力",
			),
		);
		expect(h.hook.result.current.inputHold).toBe("delayed");
		expect(h.hook.result.current.inputStatus).toBe("ready");
		expect(h.voiceCommit).not.toHaveBeenCalled();
	} finally {
		h.done();
		clock.mockRestore();
	}
});
