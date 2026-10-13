import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EumenesClient } from "../../../../client";
export function useDrawingArtifacts(client: EumenesClient, open: () => void) {
	const seen = useRef(new Set<string>());
	const query = useQuery({
		queryKey: ["drawing-operations", client.identity],
		queryFn: ({ signal }) => client.drawingOperations(signal),
		refetchInterval: 2000,
	});
	useEffect(() => {
		for (const r of query.data ?? [])
			if (!seen.current.has(r.id)) {
				seen.current.add(r.id);
				open();
			}
	}, [query.data, open]);
}
