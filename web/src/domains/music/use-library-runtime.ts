import { useRef, useState, useLayoutEffect, useMemo } from "react";
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
import { playlistStudioSource } from "./artifact-definition";
import { useTrackArtwork } from "./use-music-artwork";
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
	const studio = sources.has(playlistStudioSource);
	const latest = saved.data?.reduce<
		NonNullable<typeof saved.data>[number] | undefined
	>(
		(result, item) =>
			!result || item.createdAt > result.createdAt ? item : result,
		undefined,
	);
	const [choice, setChoice] = useState<{ id: string; latestId?: string }>();
	const initial = studio
		? choice && choice.latestId === latest?.id
			? saved.data?.find((p) => p.id === choice.id)
			: latest
		: saved.data?.find((p) => sources.has(`library-${p.id}`));
	const source = studio ? playlistStudioSource : `library-${initial?.id}`;
	const authorized = studio || !!initial;
	const defaults = useMemo(() => trackQuery.parse({}), []);
	const [filter, setFilter] = useState<{
		playlistId?: string;
		value: ReturnType<typeof trackQuery.parse>;
	}>();
	const query =
		filter && filter.playlistId === initial?.id
			? filter.value
			: (initial?.query ?? defaults);
	const enabled =
		!saved.isPending &&
		(initial?.state === "completed" || (studio && !initial));
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
	const [selected, setSelected] = useState<{
		playlistId?: string;
		id: string | null;
	}>();
	const allItems = tracks.data?.pages.flatMap((p) => p.tracks) ?? [];
	const items = allItems.filter(
		(t, i) => allItems.findIndex((other) => other.id === t.id) === i,
	);
	const id =
		selected && selected.playlistId === initial?.id
			? selected.id
			: (initial?.currentId ?? items[0]?.id);
	const detail = useQuery({
		queryKey: ["music-library", "detail", id],
		enabled: enabled && !!id,
		queryFn: ({ signal }) => client.musicTrack(id!, signal),
		retry: false,
		staleTime: 0,
	});
	const art = useTrackArtwork(client, enabled ? id : undefined);
	const [operationError, setOperationError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const lock = useRef(false),
		seen = useRef(new Set<string>());
	const currentRevision = useRef(0);
	const signature = JSON.stringify([
		initial?.id,
		initial?.updatedAt,
		query,
		id,
		tracks.dataUpdatedAt,
		tags.dataUpdatedAt,
		detail.dataUpdatedAt,
		art.signature,
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
	const fresh = detail.error ? undefined : detail.data;
	const view = (t: (typeof items)[number]) => ({
		...art.decorate(t),
		subtitle: t.prompt,
		url: fresh && t.id === id ? `/api/music/tracks/${t.id}/audio` : undefined,
		downloadName: `${t.title}.${t.format}`,
	});
	const resource: Snapshot[string] = {
		kind: "music",
		revision,
		currentId: id ?? "",
		canArtwork: art.available,
		tracks: items.map((item) =>
			view(fresh && fresh.id === item.id ? fresh : item),
		),
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
		resource.tracks.unshift(view(detail.data));
	async function refresh() {
		await cache.invalidateQueries({ queryKey: ["music-library"] });
	}
	const dispatch = async (event: ArtifactEvent): Promise<Receipt> => {
		if (!authorized || event.source !== source || !enabled)
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
					if (initial)
						await client.updateMusicPlaylist(initial.id, { query: reset });
					const key = ["music-library", "tracks", initial?.id, reset];
					await cache.cancelQueries({ queryKey: key, exact: true });
					cache.removeQueries({ queryKey: key, exact: true });
					setSelected({ playlistId: initial?.id, id: null });
					setFilter({ playlistId: initial?.id, value: reset });
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
					if (initial)
						await client.updateMusicPlaylist(initial.id, {
							currentId: target.id,
						});
					setSelected({ playlistId: initial?.id, id: target.id });
					break;
				}
				case "music-artwork":
					if (event.values.id !== id || !(await art.request()))
						return {
							status: "rejected",
							message: "この楽曲のイメージは作成できません。",
						};
					break;
				case "music-favorite":
				case "music-delete": {
					const target =
						resource.kind === "music" &&
						resource.tracks.find((t) => t.id === event.values.id);
					if (!target) throw new Error("invalid_track_reference");
					if (event.action === "music-delete") {
						await client.deleteMusicTrack(target.id);
						if (id === target.id) {
							setSelected({ playlistId: initial?.id, id: null });
							if (initial)
								await client.updateMusicPlaylist(initial.id, {
									currentId: null,
								});
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
							setSelected({ playlistId: initial?.id, id: null });
							if (initial)
								await client.updateMusicPlaylist(initial.id, {
									currentId: null,
								});
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
	const snapshot: Snapshot = authorized ? { [source]: resource } : {};
	return {
		playlists: studio ? (saved.data ?? []) : [],
		playlistId: initial?.id ?? "",
		selectPlaylist: (next: string) => {
			if (
				!studio ||
				lock.current ||
				(next && !saved.data?.some((p) => p.id === next))
			)
				return;
			setChoice({ id: next, latestId: latest?.id });
			setFilter(undefined);
			setSelected(undefined);
			setOperationError(undefined);
		},
		busy,
		runtime: { snapshot, dispatch },
		loading: saved.isPending || initial?.state === "planning",
		error:
			saved.error ??
			(!authorized && !saved.isPending
				? new Error("unauthorized_source")
				: initial?.state === "cancelled"
					? new Error("playlist_cancelled")
					: null),
		retry: () => saved.refetch(),
	};
}
