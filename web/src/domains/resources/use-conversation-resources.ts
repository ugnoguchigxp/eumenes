import { useQuery } from "@tanstack/react-query";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
import { resourcesApiFor } from "./api";

/** The conversation's resource ledger and which message each resource belongs to. */
export function useConversationResources(
	client: EumenesClient,
	conversationId: string,
) {
	return useQuery({
		queryKey: [
			queryRoots.resources,
			client.identity,
			"conversation",
			conversationId,
		],
		queryFn: ({ signal }) =>
			resourcesApiFor(client).conversationResources(conversationId, signal),
		retry: false,
	});
}
