import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { EumenesClient } from "../../../../client";

/** Loads the selected track's completed artwork through the authenticated API as a Blob URL. */
export function useMusicArtworkUrl(
	client: EumenesClient,
	id: string | undefined,
	revision: number | undefined,
) {
	const [artwork, setArtwork] = useState<{
		id: string;
		revision: number;
		url?: string;
		failed?: boolean;
	}>();
	useEffect(() => {
		if (!id || revision === undefined) return;
		const controller = new AbortController();
		let url: string | undefined;
		void client
			.musicArtwork(id, controller.signal)
			.then((blob) => {
				if (controller.signal.aborted) return;
				url = URL.createObjectURL(blob);
				setArtwork({ id, revision, url });
			})
			.catch(() => {
				if (!controller.signal.aborted)
					setArtwork({ id, revision, failed: true });
			});
		return () => {
			controller.abort();
			// Never hand back a revoked URL when the same track is selected again.
			setArtwork(undefined);
			if (url) URL.revokeObjectURL(url);
		};
	}, [client, id, revision]);
	return artwork && artwork.id === id && artwork.revision === revision
		? artwork
		: undefined;
}

/** A library track's artwork lives on the Eumenes generation behind it; LARM-only tracks have none. */
export function useTrackArtwork(
	client: EumenesClient,
	trackId: string | null | undefined,
) {
	const cache = useQueryClient();
	const key = ["music-library", "generation", trackId];
	const generation = useQuery({
		queryKey: key,
		enabled: !!trackId,
		queryFn: ({ signal }) => client.musicTrackGeneration(trackId!, signal),
		retry: false,
		refetchInterval: (q) =>
			q.state.data?.artwork?.state === "generating" ? 1000 : false,
	});
	const g = trackId ? generation.data : undefined;
	const state = g?.artwork?.state;
	const artwork = useMusicArtworkUrl(
		client,
		g?.id,
		state === "completed" ? g!.artwork!.revision : undefined,
	);
	return {
		available: !!g,
		signature: [generation.dataUpdatedAt, artwork?.url, artwork?.failed],
		decorate: <T extends { id: string }>(t: T) =>
			t.id === trackId
				? {
						...t,
						...(g?.task ? { task: g.task } : {}),
						...(g?.runtime ? { runtime: g.runtime } : {}),
						artworkStatus: artwork?.failed ? ("failed" as const) : state,
						artworkUrl: artwork?.url,
					}
				: t,
		/** Starts (or restarts) generation; false when this track cannot have artwork now. */
		request: async () => {
			if (!g || state === "generating") return false;
			await client.generateMusicArtwork(g.id);
			await cache.invalidateQueries({ queryKey: key });
			return true;
		},
	};
}
