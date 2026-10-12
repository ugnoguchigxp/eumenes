import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
/**
 * Opens only items created after this page loaded. Items that already existed,
 * or that the user has seen and closed, stay closed until reopened from the launcher.
 */
function openNew(
	opened: { current: Set<string> | null },
	items: ReadonlyArray<{ id: string; title: string }> | undefined,
	open: (id: string, title: string) => void,
) {
	if (!items) return;
	if (!opened.current) {
		opened.current = new Set(items.map((item) => item.id));
		return;
	}
	const added = items.filter((item) => !opened.current!.has(item.id));
	for (const item of added) opened.current.add(item.id);
	if (added[0]) open(added[0].id, added[0].title);
}

export function useMusicArtifacts(
	client: EumenesClient,
	conversationId: string,
	open: (id: string, title: string) => void,
) {
	const opened = useRef<Set<string> | null>(null);
	const query = useQuery({
		queryKey: [queryRoots.music, "list", conversationId],
		queryFn: ({ signal }) => client.musicList(conversationId, signal),
	});
	useEffect(() => openNew(opened, query.data, open), [query.data, open]);
	return query.data ?? [];
}

export function usePlaylistArtifacts(
	client: EumenesClient,
	conversationId: string,
	open: (id: string, title: string) => void,
) {
	const opened = useRef<Set<string> | null>(null);
	const query = useQuery({
		queryKey: ["music", "playlists", conversationId],
		queryFn: ({ signal }) => client.musicPlaylists(conversationId, signal),
	});
	useEffect(() => openNew(opened, query.data, open), [query.data, open]);
	return query.data ?? [];
}
