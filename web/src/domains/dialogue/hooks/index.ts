import {
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import type { DialogueClient } from "../../../../../client/dialogue";
import { useRef } from "react";
import type {
	Addressee,
	Submit,
	Viewing,
} from "../../../../../api/domains/dialogue/contracts";
import { conversationKey } from "../../conversation";
import { invalidateSpecialistSession } from "./specialist";
import { queryRoots } from "../../../queryKeys";
const runsKey = (identity: string, id: string) =>
	[queryRoots.dialogue, identity, id, "runs"] as const;
export function invalidateDialogueViews(
	cache: QueryClient,
	identity: string,
	id: string,
) {
	void cache.invalidateQueries({ queryKey: conversationKey(identity, id) });
	void cache.invalidateQueries({ queryKey: runsKey(identity, id) });
}
export function useRuns(client: DialogueClient, id: string) {
	return useQuery({
		queryKey: runsKey(client.identity, id),
		queryFn: ({ signal }) => client.runs(id, signal),
		staleTime: 500,
		retry: 0,
	});
}
export function useSubmit(client: DialogueClient, id: string) {
	const cache = useQueryClient();
	const pending = useRef<{ client: DialogueClient; input: Submit } | null>(
		null,
	);
	return useMutation({
		mutationFn: async (
			value:
				| string
				| {
						text: string;
						attachmentIds: string[];
						viewing?: Viewing;
						addressee?: Addressee;
				  },
		) => {
			const { text, attachmentIds, viewing, addressee } =
				typeof value === "string"
					? {
							text: value,
							attachmentIds: [],
							viewing: undefined,
							addressee: undefined,
						}
					: value;
			const previous = pending.current;
			const request =
				previous?.client === client &&
				previous.input.conversationId === id &&
				previous.input.text === text &&
				JSON.stringify(previous.input.attachmentIds ?? []) ===
					JSON.stringify(attachmentIds) &&
				JSON.stringify(previous.input.viewing ?? null) ===
					JSON.stringify(viewing ?? null) &&
				JSON.stringify(previous.input.addressee ?? null) ===
					JSON.stringify(addressee ?? null)
					? previous
					: {
							client,
							input: {
								requestId: crypto.randomUUID(),
								conversationId: id,
								text,
								...(attachmentIds.length ? { attachmentIds } : {}),
								...(viewing ? { viewing } : {}),
								...(addressee ? { addressee } : {}),
							},
						};
			// A failed acknowledgement does not prove that the server rejected the request.
			pending.current = request;
			const run = await client.submit(request.input);
			if (pending.current === request) pending.current = null;
			return run;
		},
		retry: false,
		onSuccess: () => {
			void cache.invalidateQueries({
				queryKey: conversationKey(client.identity, id),
			});
			void cache.invalidateQueries({ queryKey: runsKey(client.identity, id) });
		},
		// A refused send (the addressee changed) shows the current addressee again.
		onError: () => {
			void invalidateSpecialistSession(cache, client.identity, id);
		},
	});
}
export function useCancel(client: DialogueClient, id: string) {
	const cache = useQueryClient();
	return useMutation({
		mutationFn: (runId: string) => client.cancel(runId),
		retry: false,
		onSuccess: () => {
			void cache.invalidateQueries({ queryKey: runsKey(client.identity, id) });
		},
	});
}
