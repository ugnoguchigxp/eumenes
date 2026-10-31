import { useQuery } from "@tanstack/react-query";
import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
import { monitoringItems } from "./items";

/** One read a minute while the Spatial background is shown and the tab is visible (spec Q5). */
export function useMonitoringItems(client: EumenesClient, enabled: boolean) {
	const [visible, setVisible] = useState(
		() => document.visibilityState !== "hidden",
	);
	useEffect(() => {
		const changed = () => setVisible(document.visibilityState !== "hidden");
		document.addEventListener("visibilitychange", changed);
		return () => document.removeEventListener("visibilitychange", changed);
	}, []);
	const polling = enabled && visible;
	const query = useQuery({
		queryKey: [queryRoots.monitoring, client.identity],
		queryFn: ({ signal }) => client.monitoringSnapshot(signal),
		enabled: polling,
		staleTime: 60_000,
		refetchInterval: 60_000,
		retry: 0,
	});
	// LARM has per-measurement deadlines as short as ten seconds; this clock does not fetch.
	const clockInterval = query.data?.larm ? 1000 : 30_000;
	// An external clock refreshes when observation resumes, before cached data is painted.
	const [clock] = useState(() => {
		let at = Date.now();
		return {
			read: () => at,
			subscribe(notify: () => void, interval: number) {
				const tick = () => {
					at = Date.now();
					notify();
				};
				tick();
				const timer = setInterval(tick, interval);
				return () => clearInterval(timer);
			},
		};
	});
	const subscribe = useCallback(
		(notify: () => void) =>
			polling ? clock.subscribe(notify, clockInterval) : () => {},
		[polling, clock, clockInterval],
	);
	const now = useSyncExternalStore(subscribe, clock.read);
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
