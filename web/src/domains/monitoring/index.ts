import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
import { monitoringItems } from "./items";

/** One read a minute while the Spatial background is shown and the tab is visible (spec Q5). */
export function useMonitoringItems(client: EumenesClient, enabled: boolean) {
	const query = useQuery({
		queryKey: [queryRoots.monitoring, client.identity],
		queryFn: ({ signal }) => client.monitoringSnapshot(signal),
		enabled,
		refetchInterval: 60_000,
		retry: 0,
	});
	// Re-judge the age between reads, so a snapshot that stops arriving turns old on screen.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!enabled) return;
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, [enabled]);
	const failed = query.isError;
	const { data, dataUpdatedAt } = query;
	return useMemo(
		() =>
			enabled
				? monitoringItems(data, failed, Math.max(0, now - dataUpdatedAt))
				: undefined,
		[enabled, data, failed, now, dataUpdatedAt],
	);
}
