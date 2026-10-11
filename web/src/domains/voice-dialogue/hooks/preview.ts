import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import type { VoiceMachine } from "./machine";
import { isCurrent } from "./machine";
export type RecognitionCandidate = {
	id: string;
	finalized: boolean;
	busy: boolean;
	controller?: AbortController;
	latest?: Uint8Array;
};
export function requestPreview(
	client: VoiceDialogueClient,
	machine: VoiceMachine,
	candidate: { current: RecognitionCandidate | null },
	setPreviewText: (text: string | null) => void,
	wav: Uint8Array,
) {
	const active = machine.get().session,
		u = candidate.current;
	if (!active || !u || u.finalized || active.failed) return;
	if (u.busy) {
		u.latest = wav;
		return;
	}
	u.busy = true;
	u.controller = new AbortController();
	void client
		.voicePreview(active.id, active.generation, u.id, wav, u.controller.signal)
		.then((value) => {
			if (
				isCurrent(machine.get(), active.token) &&
				candidate.current === u &&
				!u.finalized &&
				value.text
			)
				setPreviewText(value.text);
		})
		.catch(() => {
			/* Provisional decoding never blocks the final request. */
		})
		.finally(() => {
			u.busy = false;
			const latest = u.latest;
			u.latest = undefined;
			if (latest && candidate.current === u && !u.finalized)
				requestPreview(client, machine, candidate, setPreviewText, latest);
		});
}
