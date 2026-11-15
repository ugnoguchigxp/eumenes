import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useRef } from "react";
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
import { readScreenState } from "../domains/toolchain-artifacts/screen-observation";
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
	useLayoutEffect(() => {
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
	const cache = useQueryClient();
	const tab = useRef(active);
	useLayoutEffect(() => {
		tab.current = active;
	}, [active]);
	const observation = useRef<{ sessionId: string; sequence: number } | null>(
		null,
	);
	return useCallback(() => {
		const current = tab.current;
		const entries = catalogEntries(cache);
		let viewing = specialistViewing() ?? recognitionViewing(current);
		if (current?.kind === "toolchain") {
			const entry = entries.find(
				(e) => e.artifactRevisionId === current.artifactRevisionId,
			);
			const state = readScreenState(current.id, current.artifactRevisionId);
			const ref = state?.adapterRef ?? entry?.adapterRef;
			const adapter = ref ? adapters.get(ref) : undefined;
			viewing ??= adapter?.viewingTarget?.() ?? undefined;
			if (state) {
				observation.current ??= { sessionId: crypto.randomUUID(), sequence: 0 };
				const { adapterRef: _adapterRef, ...publicState } = state;
				const screen = {
					...publicState,
					sessionId: observation.current.sessionId,
					sequence: ++observation.current.sequence,
					observedAt: new Date().toISOString(),
				};
				if (viewing) return { ...viewing, screen };
				const uri = state.phase === "ready" ? adapter?.viewing?.() : null;
				return uri ? { resource: uri, screen } : { screen };
			}
		}
		if (viewing) return viewing;
		const uri = viewingUriOf(current, entries, adapters);
		return uri ? { resource: uri } : undefined;
	}, [specialistViewing, cache, adapters]);
}
