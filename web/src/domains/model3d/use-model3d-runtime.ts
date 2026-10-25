import {
	useInfiniteQuery,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
	ArtifactEvent,
	Model3dWorkspaceResource,
	Receipt,
} from "@eumenes/artifact-ui/contracts";
import type { EumenesClient } from "../../../../client";
import { queryRoots } from "../../queryKeys";
import type { Model3dApi } from "./api";
import type {
	Model3dAsset,
	Model3dGeneration,
	Model3dQuery,
	Model3dSourceData,
} from "./contracts";
import { handleModel3dEvent, type Model3dDeps } from "./dispatch";
import { model3dArtifactSource, parseSourceData, revisionOf } from "./source";
import {
	imageContentUrl,
	imageLibraryKey,
	useImageLibrary,
} from "../../media/use-image-library";
import { uploadImage } from "../../media/upload-image";

const defaultQuery: Model3dQuery = {
	q: "",
	tags: [],
	sort: "createdAt",
	order: "desc",
};
const noGenerations: Model3dGeneration[] = [];
const activeStates = new Set<Model3dGeneration["state"]>([
	"submitting",
	"queued",
	"running",
]);

const imageTitle = (image: {
	createdAt: string;
	width: number;
	height: number;
}) => `画像 ${image.createdAt.slice(0, 10)}（${image.width}×${image.height}）`;

function toGeneration(g: Model3dGeneration) {
	return {
		id: g.id,
		title: g.title,
		tags: g.tags,
		sourceKind:
			g.source.type === "prompt" ? ("prompt" as const) : ("image" as const),
		prompt: g.source.type === "prompt" ? g.source.prompt : undefined,
		state: g.state,
		stageLabel: g.stageLabel,
		assetId: g.assetId,
		deleted: g.deleted,
		warnings: g.warnings,
		errorLabel: g.errorLabel,
	};
}
function toAsset(a: Model3dAsset) {
	const base = `/api/model3d/assets/${encodeURIComponent(a.id)}`;
	return {
		id: a.id,
		title: a.title,
		tags: a.tags,
		createdAt: a.createdAt,
		prompt: a.prompt,
		warnings: a.warnings,
		downloadUrl: `${base}/content`,
	};
}

type Props = {
	client: EumenesClient;
	api: Model3dApi;
	artifactRevisionId: string;
	/** False while the screen is hidden behind another tab. */
	visible?: boolean;
};

/** Builds the `model3d` resource and handles its events through the authenticated API. */
export function useModel3dRuntime({
	client,
	api,
	artifactRevisionId,
	visible = true,
}: Props) {
	const cache = useQueryClient();
	const root = useMemo(
		() => [queryRoots.model3d, client.identity] as const,
		[client.identity],
	);
	const [query, setQuery] = useState(defaultQuery);
	const [selectedId, setSelected] = useState<string>();
	const [highlightedId, setHighlighted] = useState<string>();
	const [appliedFocus, setAppliedFocus] =
		useState<Model3dSourceData["focus"]>(null);
	// What the workspace is told to surface; a request from this screen counts down so it never meets a host sequence.
	const [shownFocus, setShownFocus] = useState<{
		seq: number;
		kind: "asset" | "generation" | "search";
	}>();
	const localFocusSeq = useRef(0);
	const submission = useRef<{ signature: string; requestId: string } | null>(
		null,
	);

	const source = useQuery({
		queryKey: [...root, "source", artifactRevisionId],
		queryFn: async ({ signal }): Promise<Model3dSourceData> =>
			parseSourceData(
				(
					await client.toolchainArtifactSource(
						artifactRevisionId,
						model3dArtifactSource,
						undefined,
						signal,
					)
				).data,
			),
		refetchInterval: (q) =>
			q.state.data?.generations.some((g) => activeStates.has(g.state))
				? 3000
				: visible
					? 10000
					: false,
	});
	// Reading the catalog once updates the backend's availability, which the source then reports.
	const status = useQuery({
		queryKey: [...root, "status"],
		queryFn: ({ signal }) => api.status(signal),
		staleTime: 60_000,
	});
	const refetchSource = source.refetch;
	useEffect(() => {
		if (status.data) void refetchSource();
	}, [status.data, refetchSource]);
	const sourceData = source.data;
	const generations = sourceData?.generations ?? noGenerations;

	// A request from the conversation applies once per increasing sequence number.
	const focus = sourceData?.focus;
	if (focus && focus.seq > (appliedFocus?.seq ?? -1)) {
		setAppliedFocus(focus);
		setShownFocus({ seq: focus.seq, kind: focus.kind });
		if (focus.kind === "asset") setSelected(focus.assetId);
		else if (focus.kind === "generation") setHighlighted(focus.generationId);
		else
			setQuery((previous) => ({
				...previous,
				q: focus.query,
				tags: focus.tags,
			}));
	}

	const assets = useInfiniteQuery({
		queryKey: [...root, "assets", query],
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam, signal }) => api.assets(query, pageParam, signal),
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		retry: false,
	});
	const pages = assets.data?.pages ?? [];
	const items = pages.flatMap((page) => page.assets);
	const detail = useQuery({
		queryKey: [...root, "asset", selectedId],
		enabled: !!selectedId,
		queryFn: ({ signal }) => api.asset(selectedId!, signal),
		retry: false,
	});
	const selected = selectedId
		? (detail.data ?? items.find((a) => a.id === selectedId))
		: undefined;
	const images = useImageLibrary(client);
	const imageList = (images.data?.images ?? [])
		.slice()
		.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

	// A generation that finished adds an asset, so the list is read again.
	const active = useRef(new Set<string>());
	useEffect(() => {
		const finished = generations.filter(
			(g) => g.state === "completed" && active.current.has(g.id),
		);
		active.current = new Set(
			generations.filter((g) => activeStates.has(g.state)).map((g) => g.id),
		);
		if (finished.length)
			void cache.invalidateQueries({ queryKey: [...root, "assets"] });
	}, [generations, cache, root]);

	const last = pages.at(-1);
	const content = {
		kind: "model3d" as const,
		available: sourceData?.available ?? false,
		unavailableReason: sourceData?.reason ?? undefined,
		generations: generations.map(toGeneration),
		highlightedGenerationId: highlightedId,
		sourceImages: imageList.map((image) => ({
			id: image.id,
			title: imageTitle(image),
			thumbnailUrl: imageContentUrl(image.id),
			disabledReason:
				image.width < 32 || image.height < 32
					? "3D生成には縦横とも32px以上が必要です。"
					: undefined,
		})),
		sourceImagesLoading: images.isPending,
		sourceImagesError: images.error
			? "保存画像を取得できませんでした。一覧を更新してください。"
			: undefined,
		assets: items.map(toAsset),
		total: last?.total,
		hasMore: !!last?.nextCursor,
		loading: assets.isPending || assets.isFetchingNextPage,
		error: assets.error ? "3Dモデルの一覧を取得できませんでした。" : undefined,
		filter: query,
		selectedAsset: selected && toAsset(selected),
		focus: shownFocus,
	};
	const resource: Model3dWorkspaceResource = {
		...content,
		revision: revisionOf(content),
	};

	const invalidate = (key: string) =>
		cache.invalidateQueries({ queryKey: [...root, key] });
	const deps: Model3dDeps = {
		api,
		available: sourceData?.available ?? false,
		unavailableReason: sourceData?.reason ?? null,
		generations,
		hasMore: !!last?.nextCursor,
		submission,
		fetchMore: () => {
			if (!assets.isFetchingNextPage) void assets.fetchNextPage();
		},
		setQuery: (update) => setQuery(update),
		setSelected,
		setHighlighted,
		selectedId,
		refreshAll: () =>
			Promise.all([
				cache.invalidateQueries({ queryKey: root }),
				cache.invalidateQueries({ queryKey: imageLibraryKey(client) }),
			]).then(() => {}),
		refreshGenerations: () => invalidate("source"),
		refreshAssets: async () => {
			await Promise.all([invalidate("assets"), invalidate("asset")]);
		},
		assetChanged: (asset) =>
			cache.setQueryData([...root, "asset", asset.id], asset),
		assetRemoved: (id) => {
			cache.removeQueries({ queryKey: [...root, "asset", id] });
		},
	};
	/** The saved model the screen shows, by the screen's own request (a resource opened from the conversation). */
	const selection = {
		requestedId: selectedId,
		/** The asset the detail view has loaded. */
		loadedId: selected?.id,
		/** The requested asset could not be read (it does not exist). */
		failedId: detail.isError ? selectedId : undefined,
		select: (assetId: string | undefined) => {
			setSelected(assetId);
			if (!assetId) return;
			localFocusSeq.current -= 1;
			setShownFocus({ seq: localFocusSeq.current, kind: "asset" });
		},
	};
	function dispatch(event: ArtifactEvent): Promise<Receipt> {
		if (event.source !== model3dArtifactSource)
			return Promise.resolve({
				status: "rejected",
				message: "対象が見つかりません。",
			});
		return handleModel3dEvent(deps, event);
	}
	return {
		loading: source.isPending,
		error: source.error,
		selection,
		runtime: {
			snapshot: { [model3dArtifactSource]: resource },
			dispatch,
			uploadFile: async (
				source: string,
				file: File,
				context?: Readonly<Record<string, string>>,
				signal = new AbortController().signal,
			) => {
				if (source !== model3dArtifactSource || !context?.requestId)
					return {
						status: "rejected" as const,
						message: "画像の受付情報がありません。",
					};
				const result = await uploadImage(
					client,
					context.requestId,
					file,
					signal,
				);
				if (result.status === "accepted")
					await cache.invalidateQueries({ queryKey: imageLibraryKey(client) });
				return result;
			},
		},
		refresh: () => cache.invalidateQueries({ queryKey: root }),
	};
}
