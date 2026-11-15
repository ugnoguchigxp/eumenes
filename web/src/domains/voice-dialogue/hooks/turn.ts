import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { VoiceTurn } from "../../../../../api/domains/voice-dialogue/contracts";
import type { VoiceDialogueClient } from "../../../../../client/voice-dialogue";
import { queryRoots } from "../../../queryKeys";

export function useVoiceTurn(
	client: VoiceDialogueClient,
	turnId: string | null,
	onDisconnect: () => void,
) {
	const cache = useQueryClient();
	const [disconnected, setDisconnected] = useState<string | null>(null);
	useEffect(() => {
		if (!turnId) return;
		const abort = new AbortController();
		void client
			.watchVoiceInput(turnId, abort.signal, (value) => {
				if (abort.signal.aborted) return;
				cache.setQueryData<VoiceTurn>(
					[queryRoots.voiceDialogue, client.identity, turnId],
					(old) =>
						old && old.revision > value.revision ? old : { ...old, ...value },
				);
			})
			.catch(() => {
				if (!abort.signal.aborted) {
					onDisconnect();
					setDisconnected(turnId);
				}
			});
		return () => abort.abort();
	}, [client, turnId, cache, onDisconnect]);
	return useQuery({
		queryKey: [queryRoots.voiceDialogue, client.identity, turnId],
		enabled: (query) =>
			!!turnId &&
			(disconnected === turnId ||
				!["recognizing", "input_ready"].includes(
					(query.state.data as VoiceTurn | undefined)?.status ?? "",
				)),
		queryFn: () => {
			if (!turnId) throw new Error("turn_id_missing");
			return client.voiceTurn(turnId);
		},
		retry: 0,
		structuralSharing: (old, next) => {
			const before = old as VoiceTurn | undefined;
			const after = next as VoiceTurn;
			return before && before.revision > after.revision ? before : after;
		},
	});
}
