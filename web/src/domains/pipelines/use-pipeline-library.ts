import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { EumenesClient } from "../../../../client";
import type { PipelineStudioResource } from "@eumenes/artifact-ui/contracts";
import {
	imageContentUrl,
	useImageLibrary,
} from "../../media/use-image-library";

/** Uses the same authenticated libraries as the image studio and music player. No media generation. */
export function usePipelineLibrary(client: EumenesClient, visible: boolean) {
	const [kind, setKind] = useState<"image" | "music" | null>(null);
	const [query, setQuery] = useState("");
	const images = useImageLibrary(client, false, visible && kind === "image");
	const tracks = useInfiniteQuery({
		queryKey: ["pipeline-library", client.identity, "music", query],
		enabled: visible && kind === "music",
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam, signal }) =>
			client.musicTracks(
				{
					q: query,
					tags: [],
					sort: "createdAt",
					order: "desc",
					limit: 24,
					...(pageParam ? { cursor: pageParam } : {}),
				},
				signal,
			),
		getNextPageParam: (last) => last.nextCursor,
		retry: false,
	});
	const active = visible ? kind : null;
	const resource: NonNullable<PipelineStudioResource["library"]> = {
		kind: active,
		query,
		loading:
			active === "image"
				? images.isFetching
				: active === "music"
					? tracks.isFetching
					: false,
		error: (
			active === "image"
				? images.error
				: active === "music"
					? tracks.error
					: null
		)
			? "一覧を取得できませんでした。接続を確認して再試行してください。"
			: undefined,
		images:
			active === "image"
				? (images.data?.images ?? []).map((item) => ({
						id: item.id,
						title: `画像 ${item.id}`,
						thumbnailUrl: imageContentUrl(item.id),
					}))
				: [],
		tracks:
			active === "music"
				? (tracks.data?.pages.flatMap((page) => page.tracks) ?? []).map(
						(item) => ({
							id: item.id,
							title: item.title,
							durationSeconds: item.durationSeconds,
							audioUrl: `/api/music/tracks/${encodeURIComponent(item.id)}/audio`,
						}),
					)
				: [],
		hasMore: active === "music" && tracks.hasNextPage,
	};
	return {
		resource,
		open: (value: "image" | "music" | null, text = "", more = false) => {
			if (!visible && value !== null) return;
			if (value === "music" && more) {
				if (
					kind === "music" &&
					query === text &&
					tracks.hasNextPage &&
					!tracks.isFetching
				)
					void tracks.fetchNextPage();
				return;
			}
			if (kind === value && (value === "image" || query === text)) {
				if (value === "image") void images.refetch();
				else if (value === "music") void tracks.refetch();
			}
			setKind(value);
			if (value === "music") setQuery(text);
		},
	};
}
