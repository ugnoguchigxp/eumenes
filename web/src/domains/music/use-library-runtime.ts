import { useRef, useState, useLayoutEffect } from "react";
import {
	useQuery,
	useInfiniteQuery,
	useQueryClient,
} from "@tanstack/react-query";
import type { EumenesClient } from "../../../../client";
import { ApiError } from "../../../../client/transport";
import { trackQuery } from "../../../../api/domains/music/contracts";
import {
	definitionRequests,
	parseDefinition,
	type ArtifactEvent,
	type Receipt,
	type Snapshot,
} from "@eumenes/artifact-ui/contracts";
function message(error: unknown) {
	if (error instanceof ApiError) {
		if (error.status === 507 || error.message === "music_storage_full")
			return "保存容量が不足しています。不要な楽曲を削除してください。";
		if (error.status === 401) return "LARMの認証設定を確認してください。";
		if (error.status === 404) return "楽曲が削除されたか、見つかりません。";
		if (error.status === 409) return "生成中の楽曲は削除できません。";
		return error.detail ?? `操作に失敗しました（${error.message}）。`;
	}
	return "楽曲の情報を取得できませんでした。再試行してください。";
}
export function useLibraryRuntime(
	client: EumenesClient,
	conversationId: string,
	definition: string,
) {
	const cache = useQueryClient();
	const sources = (() => {
		try {
			return new Set(
				definitionRequests(parseDefinition(definition)).map((r) => r.source),
			);
		} catch {
			return new Set<string>();
		}
	})();
	const saved = useQuery({
		queryKey: ["music", "playlists", conversationId],
		queryFn: ({ signal }) => client.musicPlaylists(conversationId, signal),
	});
	const initial = saved.data?.find((p) => sources.has(`library-${p.id}`));
	const [filter, setFilter] = useState<ReturnType<typeof trackQuery.parse>>();
	const query = filter ?? initial?.query ?? trackQuery.parse({});
	const enabled = initial?.state === "completed";
	const tracks = useInfiniteQuery({
		queryKey: ["music-library", "tracks", initial?.id, query],
		enabled,
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam, signal }) =>
			client.musicTracks(
				{ ...query, ...(pageParam ? { cursor: pageParam } : {}) },
				signal,
			),
		getNextPageParam: (last) => last.nextCursor,
		retry: false,
	});
	const tags = useQuery({
		queryKey: ["music-library", "tags"],
		enabled,
		queryFn: ({ signal }) => client.musicTags(signal),
		retry: false,
	});
	const [selected, setSelected] = useState<string | null | undefined>();
	const allItems = tracks.data?.pages.flatMap((p) => p.tracks) ?? [];
	const items = allItems.filter(
		(t, i) => allItems.findIndex((other) => other.id === t.id) === i,
	);
	const id =
		selected === undefined ? (initial?.currentId ?? items[0]?.id) : selected;
	const detail = useQuery({
		queryKey: ["music-library", "detail", id],
		enabled: enabled && !!id,
		queryFn: ({ signal }) => client.musicTrack(id!, signal),
		retry: false,
		staleTime: 0,
	});
	const [operationError, setOperationError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const lock = useRef(false),
		seen = useRef(new Set<string>());
	const currentRevision = useRef(0);
	const signature = JSON.stringify([
		initial?.updatedAt,
		query,
		id,
		tracks.dataUpdatedAt,
		tags.dataUpdatedAt,
		detail.dataUpdatedAt,
		tracks.isFetching,
		tags.isFetching,
		busy,
		operationError,
	]);
	const [version, setVersion] = useState({ signature, revision: 1 });
	const revision = version.revision + (version.signature === signature ? 0 : 1);
	if (version.signature !== signature) setVersion({ signature, revision });
	useLayoutEffect(() => {
		currentRevision.current = revision;
	}, [revision]);
	const resource: Snapshot[string] = {
		kind: "music",
		revision,
		currentId: id ?? "",
		tracks: items.map((item) => {
			const t =
				detail.data?.id === item.id && !detail.error ? detail.data : item;
			return {
				...t,
				subtitle: t.prompt,
				url:
					t.id === id && detail.data && !detail.error
						? `/api/music/tracks/${t.id}/audio`
						: undefined,
				downloadName: `${t.title}.${t.format}`,
			};
		}),
		library: {
			filter: query,
			tags: tags.data?.tags ?? [],
			loading: tracks.isFetching || tags.isFetching || busy,
			error:
				operationError ??
				(tracks.error
					? message(tracks.error)
					: tags.error
						? message(tags.error)
						: detail.error
							? message(detail.error)
							: initial?.state === "failed"
								? `選曲に失敗しました（${initial.errorCode}）。`
								: undefined),
			total: tracks.data?.pages[0]?.total,
			hasMore: !!tracks.hasNextPage,
		},
	};
	// A persisted selection can belong to a later page. Refresh its current details before playback.
	if (
		resource.kind === "music" &&
		detail.data &&
		!detail.error &&
		!resource.tracks.some((t) => t.id === detail.data.id)
	)
		resource.tracks.unshift({
			...detail.data,
			subtitle: detail.data.prompt,
			url: `/api/music/tracks/${detail.data.id}/audio`,
			downloadName: `${detail.data.title}.${detail.data.format}`,
		});
	async function refresh() {
		await cache.invalidateQueries({ queryKey: ["music-library"] });
	}
	const dispatch = async (event: ArtifactEvent): Promise<Receipt> => {
		if (!initial || event.source !== `library-${initial.id}` || !enabled)
			return {
				status: "rejected",
				message: "このプレイリストは操作できません。",
			};
		if (event.revision !== currentRevision.current)
			return {
				status: "conflict",
				message: "一覧が更新されました。もう一度操作してください。",
			};
		if (seen.current.has(event.id))
			return { status: "duplicate", message: "操作済みです。" };
		if (lock.current)
			return {
				status: "conflict",
				message: "操作を完了するまでお待ちください。",
			};
		lock.current = true;
		setBusy(true);
		setOperationError(undefined);
		try {
			switch (event.action) {
				case "music-search": {
					const next = trackQuery.parse(
						JSON.parse(String(event.values.filter)),
					);
					const { cursor: _, ...reset } = next;
					await client.updateMusicPlaylist(initial.id, { query: reset });
					const key = ["music-library", "tracks", initial.id, reset];
					await cache.cancelQueries({ queryKey: key, exact: true });
					cache.removeQueries({ queryKey: key, exact: true });
					setSelected(null);
					setFilter(reset);
					break;
				}
				case "music-more":
					if (tracks.hasNextPage)
						await tracks.fetchNextPage({ cancelRefetch: false });
					break;
				case "music-refresh":
					await refresh();
					break;
				case "music-select": {
					const target =
						resource.kind === "music" &&
						resource.tracks.find((t) => t.id === event.values.id);
					if (!target) throw new Error("invalid_track_reference");
					await client.updateMusicPlaylist(initial.id, {
						currentId: target.id,
					});
					setSelected(target.id);
					break;
				}
				case "music-favorite":
				case "music-delete": {
					const target =
						resource.kind === "music" &&
						resource.tracks.find((t) => t.id === event.values.id);
					if (!target) throw new Error("invalid_track_reference");
					if (event.action === "music-delete") {
						await client.deleteMusicTrack(target.id);
						if (id === target.id) {
							setSelected(null);
							await client.updateMusicPlaylist(initial.id, { currentId: null });
						}
					} else {
						if (typeof event.values.favorite !== "boolean")
							throw new Error("invalid_favorite");
						await client.musicFavorite(target.id, event.values.favorite);
						if (
							query.favorite !== undefined &&
							event.values.favorite !== query.favorite &&
							id === target.id
						) {
							setSelected(null);
							await client.updateMusicPlaylist(initial.id, { currentId: null });
						}
					}
					await refresh();
					break;
				}
				default:
					return { status: "rejected", message: "許可されていない操作です。" };
			}
			seen.current.add(event.id);
			return { status: "accepted", message: "操作を反映しました。" };
		} catch (error) {
			const text = message(error);
			setOperationError(text);
			return { status: "rejected", message: text };
		} finally {
			lock.current = false;
			setBusy(false);
		}
	};
	const snapshot: Snapshot = initial
		? { [`library-${initial.id}`]: resource }
		: {};
	return {
		runtime: { snapshot, dispatch },
		loading: saved.isPending || initial?.state === "planning",
		error:
			saved.error ??
			(!initial && !saved.isPending
				? new Error("unauthorized_source")
				: initial?.state === "cancelled"
					? new Error("playlist_cancelled")
					: null),
		retry: () => saved.refetch(),
	};
}
