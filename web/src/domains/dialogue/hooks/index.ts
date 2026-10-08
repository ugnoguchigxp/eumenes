import {
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import type { DialogueClient } from "../../../../../client/dialogue";
import { useRef } from "react";
import type { Submit } from "../../../../../api/domains/dialogue/contracts";
import { conversationKey } from "../../conversation";
export const runsKey = (identity: string, id: string) =>
	["dialogue", identity, id, "runs"] as const;
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
		mutationFn: async (text: string) => {
			const previous = pending.current;
			const request =
				previous?.client === client &&
				previous.input.conversationId === id &&
				previous.input.text === text
					? previous
					: {
							client,
							input: {
								requestId: crypto.randomUUID(),
								conversationId: id,
								text,
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
