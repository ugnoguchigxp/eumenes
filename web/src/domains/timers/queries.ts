import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";

/** A shared workspace query reads running and paused clocks for every consumer. */
export function activeTimersQuery(client: EumenesClient) {
	return {
		queryKey: [queryRoots.timers, "workspace"] as const,
		queryFn: async ({ signal }: { signal: AbortSignal }) => {
			// The answer was made no earlier than this local instant; see useDeadline.
			const sentAt = Date.now();
			const [active, paused] = await Promise.all([
				client.timers({ state: "active", limit: 100 }, signal),
				client.timers({ state: "paused", limit: 100 }, signal),
			]);
			return { ...active, items: [...active.items, ...paused.items], sentAt };
		},
	};
}
