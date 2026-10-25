import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import type { ToolchainArtifactEntry } from "../../../client/toolchain-actions";
import type {
	RunViewing,
	Viewing,
} from "../../../api/domains/dialogue/contracts";
import type { useArtifactWorkspace } from "../domains/artifact";
import {
	DRAWING_TAB_ID,
	drawingScreen,
} from "../domains/excalidraw/resource-screen";
import { recognitionViewing } from "../domains/object-recognition/chat-inbox";
import { musicPlaylistScreen } from "../domains/music/playlist-screen";
import {
	type WebAdapterRegistry,
	type WebArtifactAdapter,
} from "../domains/toolchain-artifacts/registry";
import { queryRoots } from "../queryKeys";
import { toolchainWebAdapters } from "./toolchain-adapters";

type ActiveTab = ReturnType<typeof useArtifactWorkspace>["active"];

/** Screens that are stored OpenUI tabs, not registered artifacts: their own part of the adapter contract. */
const openuiScreens: Readonly<
	Record<string, Pick<WebArtifactAdapter, "viewing">>
> = {
	[DRAWING_TAB_ID]: drawingScreen,
	"music-playlist": musicPlaylistScreen,
};

/** The registered artifacts the launcher list read (the catalog `useToolchainArtifacts` keeps). */
function catalogEntries(cache: QueryClient) {
	return cache
		.getQueriesData<ToolchainArtifactEntry[]>({
			queryKey: [queryRoots.toolchainArtifacts],
		})
		.filter(([key, data]) => key[2] === "list" && Array.isArray(data))
		.flatMap(([, data]) => data ?? []);
}

/**
 * The resource URI of what the visible tab's screen shows now, from its adapter's `viewing()`;
 * null when the tab is not a screen of resources or shows none.
 */
export function viewingUriOf(
	tab: ActiveTab,
	entries: readonly Pick<
		ToolchainArtifactEntry,
		"artifactRevisionId" | "adapterRef"
	>[],
	adapters: WebAdapterRegistry,
): string | null {
	if (!tab) return null;
	if (tab.kind === "openui") return openuiScreens[tab.id]?.viewing?.() ?? null;
	if (tab.kind !== "toolchain") return null;
	const entry = entries.find(
		(e) => e.artifactRevisionId === tab.artifactRevisionId,
	);
	return (entry && adapters.get(entry.adapterRef)?.viewing?.()) ?? null;
}

/** Reads the visible tab's resource URI when called (a message is being sent). */
export function useViewingUri(
	active: ActiveTab,
	adapters: WebAdapterRegistry = toolchainWebAdapters,
) {
	const cache = useQueryClient();
	const tab = useRef(active);
	useEffect(() => {
		tab.current = active;
	}, [active]);
	return useCallback(
		() => viewingUriOf(tab.current, catalogEntries(cache), adapters),
		[cache, adapters],
	);
}

/**
 * What a message refers to when sent now: the specialist's saved work, else a still on the recognition screen,
 * else the resource the visible screen shows.
 */
export function useCurrentViewing(
	specialistViewing: () => Viewing | undefined,
	active: ActiveTab,
	adapters: WebAdapterRegistry = toolchainWebAdapters,
): () => RunViewing | undefined {
	const tab = useRef(active);
	useEffect(() => {
		tab.current = active;
	}, [active]);
	const viewingUri = useViewingUri(active, adapters);
	return useCallback(() => {
		const viewing = specialistViewing() ?? recognitionViewing(tab.current);
		if (viewing) return viewing;
		const uri = viewingUri();
		return uri ? { resource: uri } : undefined;
	}, [specialistViewing, viewingUri]);
}
