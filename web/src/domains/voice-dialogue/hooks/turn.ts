import { useQuery } from "@tanstack/react-query";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import { queryRoots } from "../../../queryKeys";

export function useVoiceTurn(
	client: VoiceDialogueClient,
	turnId: string | null,
) {
	return useQuery({
		queryKey: [queryRoots.voiceDialogue, client.identity, turnId],
		enabled: !!turnId,
		queryFn: () => {
			if (!turnId) throw new Error("turn_id_missing");
			return client.voiceTurn(turnId);
		},
		retry: 0,
	});
}
