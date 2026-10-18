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
import { useBlobUrls } from "./use-blob-urls";

const defaultQuery: Model3dQuery = {
	q: "",
	tags: [],
	sort: "createdAt",
	order: "desc",
};
/** Source images whose thumbnails are fetched; the rest are still listed by name. */
const thumbnailLimit = 24;
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
		thumbnailUrl: a.hasSource ? `${base}/source` : undefined,
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
	const [appliedSeq, setAppliedSeq] = useState(-1);
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
	if (focus && focus.seq > appliedSeq) {
		setAppliedSeq(focus.seq);
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
	const images = useQuery({
		queryKey: [...root, "images"],
		queryFn: ({ signal }) => client.imageLibrary(signal),
		retry: false,
	});
	const imageList = (images.data?.images ?? [])
		.slice()
		.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
	const thumbnails = useBlobUrls(
		imageList.slice(0, thumbnailLimit).map((image) => image.id),
		(id) => client.imageContent(id),
	);

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
			thumbnailUrl: thumbnails[image.id],
		})),
		sourceImagesLoading: images.isPending,
		assets: items.map(toAsset),
		total: last?.total,
		hasMore: !!last?.nextCursor,
		loading: assets.isPending || assets.isFetchingNextPage,
		error: assets.error ? "3Dモデルの一覧を取得できませんでした。" : undefined,
		filter: query,
		selectedAsset: selected && toAsset(selected),
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
		refreshAll: () => cache.invalidateQueries({ queryKey: root }),
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
		runtime: {
			snapshot: { [model3dArtifactSource]: resource },
			dispatch,
		},
		refresh: () => cache.invalidateQueries({ queryKey: root }),
	};
}
