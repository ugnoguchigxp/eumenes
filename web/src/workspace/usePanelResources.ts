import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { EumenesClient } from "../../../client";
import {
	MUSIC_PLAYLIST_ADAPTER_REF,
	musicPlaylistScreen,
} from "../domains/music/playlist-screen";
import {
	useConversationResources,
	useResourceNotice,
	useResourceOpener,
	type ResourceLauncher,
} from "../domains/resources";
import {
	DRAWING_ADAPTER_REF,
	drawingScreen,
} from "../domains/excalidraw/resource-screen";
import { toolchainArtifactsQuery } from "../domains/toolchain-artifacts/launcher";
import { toolchainWebAdapters } from "./toolchain-adapters";
import type { WorkspaceState } from "./useWorkspace";

const CONVERSATION_ID = "main";

/** The resources of the conversation, the way one is opened, and the notice shown when it cannot be. */
export function usePanelResources(
	client: EumenesClient,
	state: WorkspaceState,
) {
	const cache = useQueryClient();
	const { openByAdapter } = state.toolchain;
	const { openPlaylist, openDrawing } = state;
	// How a resource reaches a screen: the registered artifact of its adapter, or the playlist or drawing tab.
	const launcher = useMemo<ResourceLauncher>(
		() => ({
			open: async (adapterRef, targetRef) => {
				if (adapterRef === MUSIC_PLAYLIST_ADAPTER_REF) {
					openPlaylist(targetRef);
					return true;
				}
				if (adapterRef === DRAWING_ADAPTER_REF) {
					openDrawing();
					return true;
				}
				const entries = await cache
					.fetchQuery(toolchainArtifactsQuery(client))
					.catch(() => []);
				if (!entries.some((entry) => entry.adapterRef === adapterRef))
					return false;
				await openByAdapter(adapterRef, targetRef);
				return true;
			},
			screen: (adapterRef) =>
				adapterRef === MUSIC_PLAYLIST_ADAPTER_REF
					? musicPlaylistScreen
					: adapterRef === DRAWING_ADAPTER_REF
						? drawingScreen
						: toolchainWebAdapters.get(adapterRef),
		}),
		[cache, client, openByAdapter, openPlaylist, openDrawing],
	);
	const notice = useResourceNotice();
	const openResource = useResourceOpener({
		client,
		launcher,
		notify: notice.show,
	});
	const resources = useConversationResources(client, CONVERSATION_ID);
	return { resources, openResource, notice };
}
