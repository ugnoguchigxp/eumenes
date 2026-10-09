import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";

type Ref = { kind: "timer"; version: 1; timerId: string };
/** Application supplies the workspace port; this hook owns API discovery and deduplication. */
export function useTimerArtifacts(
	client: EumenesClient,
	open: (ref: Ref, title: string) => void,
	runs?: ReadonlyArray<{ id: string; status: string }>,
) {
	const cache = useQueryClient();
	const opened = useRef(new Set<string>());
	const [watched, setWatched] = useState<Array<{ id: string; until: number }>>(
		[],
	);
	const watchRun = useCallback((id: string) => {
		setWatched((current) =>
			current.some((run) => run.id === id)
				? current
				: [...current, { id, until: performance.now() + 180000 }].slice(-8),
		);
	}, []);
	const active = useQuery({
		queryKey: [queryRoots.timers, "workspace"],
		queryFn: ({ signal }) =>
			client.timers({ state: "active", limit: 100 }, signal),
		refetchInterval: (query) =>
			query.state.data?.items.some((item) => item.state === "active")
				? 5000
				: false,
	});
	useEffect(() => {
		if (!runs?.length) return;
		// Voice results can reach the conversation before the local turn callback.
		// Discover persisted timers even if the change stream missed their creation.
		void cache.invalidateQueries({
			queryKey: [queryRoots.timers, "workspace"],
		});
	}, [cache, runs]);
	const receipts = useQuery({
		queryKey: [queryRoots.timers, "artifacts", ...watched.map((run) => run.id)],
		enabled: watched.length > 0,
		queryFn: ({ signal }) =>
			Promise.all(
				watched.map(async (run) => ({
					id: run.id,
					...(await client.timerReceiptByRun(run.id, signal)),
				})),
			),
		refetchInterval: 2000,
	});
	useEffect(() => {
		const show = (ref: Ref, title: string) => {
			if (opened.current.has(ref.timerId)) return;
			opened.current.add(ref.timerId);
			open(ref, title);
		};
		for (const timer of [...(active.data?.items ?? [])].reverse())
			show({ kind: "timer", version: 1, timerId: timer.id }, timer.label);
		const finished = new Set<string>();
		for (const view of receipts.data ?? []) {
			if (
				!view.receipt &&
				!runs?.some(
					(run) =>
						run.id === view.id && !["queued", "running"].includes(run.status),
				)
			)
				continue;
			finished.add(view.id);
			if (view.receipt?.action === "started")
				show(view.receipt.artifact, view.receipt.timer.label);
		}
		if (finished.size)
			queueMicrotask(() =>
				setWatched((current) => {
					const next = current.filter((run) => !finished.has(run.id));
					return next.length === current.length ? current : next;
				}),
			);
	}, [active.data, receipts.data, open, runs]);
	useEffect(() => {
		if (!watched.length) return;
		const timeout = setTimeout(
			() =>
				setWatched((current) =>
					current.filter((run) => run.until > performance.now()),
				),
			Math.max(
				0,
				Math.min(...watched.map((run) => run.until)) - performance.now(),
			),
		);
		return () => clearTimeout(timeout);
	}, [watched]);
	return watchRun;
}
