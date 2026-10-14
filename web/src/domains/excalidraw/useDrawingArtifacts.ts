import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
export function useDrawingArtifacts(client: EumenesClient, open: () => void) {
	const seen = useRef<Set<string> | null>(null);
	const query = useQuery({
		queryKey: [queryRoots.drawingOperations, client.identity],
		queryFn: ({ signal }) => client.drawingOperations(signal),
		refetchInterval: 2000,
	});
	useEffect(() => {
		if (!query.data) return;
		if (!seen.current) {
			seen.current = new Set(query.data.map((r) => r.id));
			return;
		}
		const added = query.data.filter((r) => !seen.current!.has(r.id));
		for (const r of added) seen.current.add(r.id);
		if (added.length) open();
	}, [query.data, open]);
}
