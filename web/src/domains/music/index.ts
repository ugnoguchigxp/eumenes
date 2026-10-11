import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
export function useMusicArtifacts(
	client: EumenesClient,
	conversationId: string,
	open: (id: string, title: string) => void,
) {
	const opened = useRef(new Set<string>());
	const query = useQuery({
		queryKey: [queryRoots.music, "list", conversationId],
		queryFn: ({ signal }) => client.musicList(conversationId, signal),
	});
	useEffect(() => {
		for (const item of [...(query.data ?? [])].reverse()) {
			if (opened.current.has(item.id)) continue;
			opened.current.add(item.id);
			open(item.id, item.title);
		}
	}, [query.data, open]);
}
