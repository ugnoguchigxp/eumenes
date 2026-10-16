import type { QueryClient } from "@tanstack/react-query";
import type { VoiceTurn } from "../../../../../api/domains/voice-dialogue/contracts";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import type { AudioController } from "../../audio";
import { describeError } from "../../../errorMessages";
import { queryRoots } from "../../../queryKeys";
import type { RecognitionCandidate } from "./preview";
import { isCurrent, type VoiceMachine } from "./machine";

export function commitIdleInput(
	value: VoiceTurn,
	client: VoiceDialogueClient,
	cache: QueryClient,
	machine: VoiceMachine,
	inputEnabled: boolean,
	candidate: RecognitionCandidate | null,
	controller: AudioController | null,
	committing: Set<string>,
	setError: (error: string) => void,
) {
	const session = machine.get().session;
	if (
		!inputEnabled ||
		!session ||
		session.pending ||
		candidate ||
		controller?.isInputBusy?.() ||
		committing.has(value.utteranceId)
	)
		return;
	committing.add(value.utteranceId);
	void client
		.voiceCommit(value.utteranceId, value.revision)
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
