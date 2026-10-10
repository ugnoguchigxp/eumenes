import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";

/** One shared query for the active timers, so every consumer reuses a single request. */
export function activeTimersQuery(client: EumenesClient) {
	return {
		queryKey: [queryRoots.timers, "workspace"] as const,
		queryFn: async ({ signal }: { signal: AbortSignal }) => {
			// The answer was made no earlier than this local instant; see useDeadline.
			const sentAt = Date.now();
			return {
				...(await client.timers({ state: "active", limit: 100 }, signal)),
				sentAt,
			};
		},
	};
}
