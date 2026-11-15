import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { expect, test, vi } from "vitest";
import type { VoiceTurn } from "../../../../../api/domains/voice-dialogue/contracts";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import { createAudioStore, type CreateAudio } from "../../audio";
import { useVoiceDialogue } from "..";
import { inputClientFixture } from "./input-client.fixture";

for (const recognized of [false, true, "failed"])
	test(`replacement cancels the accepted answer only after confirmed speech: ${recognized}`, async () => {
		const query = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const wrapper = ({ children }: PropsWithChildren) => (
			<QueryClientProvider client={query}>{children}</QueryClientProvider>
		);
		let sessionId = "",
			segment = (_wav: Uint8Array) => {},
			speech = () => {};
		const ids: string[] = [];
		const receivers = new Map<string, (turn: VoiceTurn) => void>();
		const states = new Map<string, { status: string; text: string | null }>();
		const voiceCancel = vi.fn(async () => ({})),
			play = vi.fn(async () => {});
		const client = inputClientFixture({
			identity: "replacement-test",
			watchVoiceInput: (
				id: string,
				_signal: AbortSignal,
				receive: (turn: VoiceTurn) => void,
			) => {
				receivers.set(id, receive);
				void client.voiceTurn(id).then(receive);
				return new Promise<void>(() => {});
			},
			voiceStart: async (id: string) => {
				sessionId = id;
			},
			voiceStop: async () => ({}),
			voiceSend: async (
				_session: string,
				_generation: number,
				_sequence: number,
				id: string,
			) => {
				ids.push(id);
				states.set(
					id,
					ids.length === 1
						? { status: "responding", text: "受け付けた依頼" }
						: { status: "recognizing", text: null },
				);
				return { utteranceId: id };
			},
			voiceTurn: async (id: string) => ({
				utteranceId: id,
				sessionId,
				generation: 1,
				sequence: ids.indexOf(id) + 1,
				...states.get(id),
				runId: "run",
				error: states.get(id)?.status === "failed" ? "larm_timeout" : null,
				revision: 1,
			}),
			voiceAudio: async () => new Uint8Array(44),
			voicePlayed: async () => ({}),
			voiceCancel,
		} as unknown as VoiceDialogueClient);
		const createAudio: CreateAudio = (_state, onSpeech, onSegment) => {
			speech = onSpeech;
			segment = onSegment;
			return {
				start: async () => {},
				stop: async () => {},
				stopPlayback: () => {},
				play,
			};
		};
		const hook = renderHook(
			() => useVoiceDialogue(client, createAudioStore(), createAudio),
			{ wrapper },
		);
		try {
			await act(async () => hook.result.current.start());
			act(() => segment(new Uint8Array(44)));
			await waitFor(() =>
				expect(hook.result.current.turn?.text).toBe("受け付けた依頼"),
			);
			act(() => {
				speech();
				segment(new Uint8Array(44));
			});
			await waitFor(() =>
				expect(hook.result.current.turn?.status).toBe("recognizing"),
			);
			expect(voiceCancel).not.toHaveBeenCalled();
			states.set(
				ids[1]!,
				recognized === "failed"
					? { status: "failed", text: "" }
					: recognized
						? { status: "responding", text: "新しい依頼" }
						: { status: "completed", text: "" },
			);
			await act(async () => {
				receivers.get(ids[1]!)!(await client.voiceTurn(ids[1]!));
			});
			if (recognized === true) {
				await waitFor(() => expect(voiceCancel).toHaveBeenCalledWith(ids[0]));
				expect(voiceCancel).toHaveBeenCalledTimes(1);
			} else {
				await waitFor(() =>
					expect(hook.result.current.turn?.utteranceId).toBe(ids[0]),
				);
				expect(voiceCancel).not.toHaveBeenCalled();
				if (recognized === "failed")
					expect(hook.result.current.failure).toMatchObject({
						cause: "larm_timeout",
						turn: { utteranceId: ids[1], runId: "run" },
					});
				states.set(ids[0]!, { status: "ready", text: "受け付けた依頼" });
				await act(async () => {
					await query.invalidateQueries();
				});
				await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
			}
		} finally {
			hook.unmount();
			query.clear();
		}
	});
