import type { VoiceTurn } from "../../../../../api/domains/voice-dialogue/contracts";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";

/** Playback fixtures supply their own result; the input transport now supplies full receipts and direct events. */
export function inputClientFixture(
	fake: VoiceDialogueClient,
): VoiceDialogueClient {
	const accepted = new Map<string, VoiceTurn>();
	return {
		...fake,
		async voiceSend(sessionId, generation, sequence, utteranceId, wav) {
			const result = await fake.voiceSend(
				sessionId,
				generation,
				sequence,
				utteranceId,
				wav,
			);
			const turn: VoiceTurn = {
				sessionId,
				generation,
				sequence,
				utteranceId,
				status: "recognizing",
				text: null,
				runId: null,
				error: null,
				revision: 0,
				...(result as Partial<VoiceTurn> | undefined),
			};
			accepted.set(utteranceId, turn);
			return turn;
		},
		watchVoiceInput:
			fake.watchVoiceInput ??
			(async (id, signal, receive) => {
				const turn = { ...accepted.get(id)!, ...(await fake.voiceTurn(id)) };
				if (signal.aborted) return;
				receive(turn);
				if (turn.status === "recognizing")
					await new Promise<void>((resolve) =>
						signal.addEventListener("abort", () => resolve(), { once: true }),
					);
			}),
		async voiceCommit(id, revision, viewing, timing) {
			const result = await fake.voiceCommit(id, revision, viewing, timing);
			return { ...accepted.get(id)!, ...(await fake.voiceTurn(id)), ...result };
		},
	};
}
