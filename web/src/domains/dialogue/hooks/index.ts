import {
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import type { DialogueClient } from "../../../../../client/dialogue";
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
	return useMutation({
		mutationFn: (text: string) =>
			client.submit({
				requestId: crypto.randomUUID(),
				conversationId: id,
				text,
			}),
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
