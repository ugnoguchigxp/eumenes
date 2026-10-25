import type { QueryClient } from "@tanstack/react-query";
import type { VoiceTurn } from "../../../../../api/domains/voice-dialogue/contracts";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import type { AudioController } from "../../audio";
import { describeError } from "../../../errorMessages";
import { queryRoots } from "../../../queryKeys";
import type { RecognitionCandidate } from "./preview";
import { isCurrent, type VoiceMachine } from "./machine";
import type { InputLedger } from "./input-timing";

export function commitIdleInput(
	value: VoiceTurn,
	client: VoiceDialogueClient,
	cache: QueryClient,
	machine: VoiceMachine,
	inputEnabled: boolean,
	candidate: RecognitionCandidate | null,
	controller: AudioController | null,
	inputs: InputLedger,
	setError: (error: string) => void,
) {
	const session = machine.get().session;
	if (
		!inputEnabled ||
		!session ||
		session.pending ||
		candidate ||
		controller?.isInputBusy?.() ||
		inputs.committing.has(value.utteranceId)
	)
		return;
	inputs.committing.add(value.utteranceId);
	// The transcript is on screen now (this runs with the render that shows it).
	void client
		.voiceCommit(
			value.utteranceId,
			value.revision,
			undefined,
			inputs.shown(value.utteranceId),
		)
		.then(() => {
			if (isCurrent(machine.get(), session.token))
				return cache.invalidateQueries({
					queryKey: [
						queryRoots.voiceDialogue,
						client.identity,
						value.utteranceId,
					],
				});
		})
		.catch((e) => {
			// A segment that arrived meanwhile continues this input; it is sent with that one.
			if (e instanceof Error && e.message === "voice_input_stale") return;
			if (isCurrent(machine.get(), session.token)) setError(describeError(e));
		});
}
