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
		segment = (_wav: Uint8Array) => {},
		partial = () => {};
	let sessionId = "",
		preview = "",
		busy = false;
	const turns = new Map<string, VoiceTurn>();
	const ids: string[] = [];
	const voiceCommit = vi.fn(async (id: string) => {
		const turn = turns.get(id)!;
		turn.status = "responding";
		turn.runId = "accepted-run";
		return turn;
	});
	const client = {
		identity: "correction-test",
		voiceStart: async (id: string) => {
			sessionId = id;
		},
		voiceStop: async () => {},
		voiceCancel: async () => {},
		voicePreview: async () => ({ text: preview }),
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
		},
		voiceTurn: async (id: string) => ({ ...turns.get(id)! }),
		voiceCommit,
	} as unknown as VoiceDialogueClient;
	const createAudio: CreateAudio = (_state, onSpeech, onSegment, options) => {
		speech = () => {
			busy = true;
			onSpeech();
		};
		segment = (wav) => {
			busy = false;
			onSegment(wav);
		};
		partial = () => options?.onPartial?.(new Uint8Array(44));
		return {
			start: async () => {},
			stop: async () => {},
			pauseInput() {},
			stopPlayback() {},
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
		speech: () => act(() => speech()),
		segment: () => act(() => segment(new Uint8Array(44))),
		preview: async (text: string) => {
			preview = text;
			await act(async () => partial());
		},
		update: async (index: number, patch: Partial<VoiceTurn>) => {
			Object.assign(turns.get(ids[index]!)!, patch);
			await act(async () => {
				await cache.invalidateQueries();
			});
		},
		done: () => {
			hook.unmount();
			cache.clear();
		},
	};
}

test("preview keeps pending input, then only the server-adopted text is committed once", async () => {
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
		await h.preview("いえ、来週の予定を教えて");
		const expected = "明日の予定を\nいえ、来週の予定を教えて";
		await waitFor(() =>
			expect(h.hook.result.current.transcription?.text).toBe(expected),
		);
		h.segment();
		await waitFor(() => expect(h.ids).toHaveLength(2));
		expect(h.hook.result.current.transcription?.text).toBe(expected);
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
		await h.preview("次の依頼です");
		expect(h.hook.result.current.transcription?.text).toBe("次の依頼です");
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
