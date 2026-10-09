import { useQuery } from "@tanstack/react-query";
import type { ConversationClient } from "../../../../../client/conversation";
import { queryRoots } from "../../../queryKeys";
export const conversationKey = (identity: string, id: string) =>
	[queryRoots.conversation, identity, id] as const;
export function useConversation(client: ConversationClient, id: string) {
	return useQuery({
		queryKey: conversationKey(client.identity, id),
		queryFn: ({ signal }) => client.conversation(id, signal),
		staleTime: 1000,
		retry: 0,
	});
}
