import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
export function useImageArtifacts(
	client: EumenesClient,
	conversationId: string,
	open: () => void,
) {
	const seen = useRef<Set<string> | null>(null);
	const query = useQuery({
		queryKey: [queryRoots.image, "generations", conversationId],
		queryFn: ({ signal }) => client.imageGenerations(conversationId, signal),
	});
	useEffect(() => {
		if (!query.data) return;
		if (!seen.current) {
			seen.current = new Set(query.data.map((item) => item.id));
			return;
		}
		const added = query.data.filter((item) => !seen.current!.has(item.id));
		for (const item of added) seen.current.add(item.id);
		if (added.length) open();
	}, [query.data, open]);
	return query.data ?? [];
}
