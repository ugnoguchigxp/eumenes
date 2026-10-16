import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { expect, test, vi } from "vitest";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import { createAudioStore, type CreateAudio } from "../../audio";
import { useVoiceDialogue } from "..";

for (const pause of [false, true])
	test(`latest ready input is committed only with idle active capture: pause=${pause}`, async () => {
		const cache = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const wrapper = ({ children }: PropsWithChildren) => (
			<QueryClientProvider client={cache}>{children}</QueryClientProvider>
		);
		let speech = () => {},
			segment = (_wav: Uint8Array) => {},
			sessionId = "";
		const ids: string[] = [];
		const status = new Map<string, string>();
		const voiceCommit = vi.fn(async (id: string) => {
			status.set(id, "responding");
			return {};
		});
		const client = {
			identity: "input-test",
			voiceStart: async (id: string) => {
				sessionId = id;
			},
			voiceStop: async () => {},
			voiceCancel: async () => {},
			voiceSend: async (
				_session: string,
				_gen: number,
				_seq: number,
				id: string,
				_wav: Uint8Array,
			) => {
				ids.push(id);
				status.set(id, "recognizing");
			},
			voiceTurn: async (id: string) => ({
				utteranceId: id,
				sessionId,
				generation: 1,
				sequence: ids.indexOf(id) + 1,
				revision: 2,
				status: status.get(id),
				text: "依頼です",
				runId: null,
			}),
			voiceCommit,
		} as unknown as VoiceDialogueClient;
		const createAudio: CreateAudio = (_state, onSpeech, onSegment) => {
			speech = onSpeech;
			segment = onSegment;
			return {
				start: async () => {},
				stop: async () => {},
				pauseInput() {},
				stopPlayback() {},
				play: async () => {},
			};
		};
		const hook = renderHook(
			() => useVoiceDialogue(client, createAudioStore(), createAudio),
			{ wrapper },
		);
		const refresh = () => cache.invalidateQueries();
		try {
			await act(async () => hook.result.current.start());
			act(() => {
				speech();
				segment(new Uint8Array(44));
			});
			await waitFor(() => expect(ids).toHaveLength(1));
			act(() => speech()); // Start speaking again before the old recognition finishes.
			status.set(ids[0]!, "input_ready");
			await act(async () => refresh());
			expect(voiceCommit).not.toHaveBeenCalled();
			act(() => segment(new Uint8Array(44)));
			await waitFor(() => expect(ids).toHaveLength(2));
			await waitFor(() =>
				expect(hook.result.current.turn?.utteranceId).toBe(ids[1]),
			);
			if (pause) act(() => hook.result.current.pause());
			status.set(ids[1]!, "input_ready");
			await act(async () => refresh());
			if (pause) {
				expect(voiceCommit).not.toHaveBeenCalled();
				await act(async () => hook.result.current.start());
			}
			await waitFor(() => expect(voiceCommit).toHaveBeenCalledTimes(1));
			expect(voiceCommit).toHaveBeenCalledWith(ids[1], 2);
		} finally {
			hook.unmount();
			cache.clear();
		}
	});
