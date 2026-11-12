import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { SCRATCH_ADAPTER_REF } from "../../../api/domains/scratch/contracts";
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
import { useShownNotes } from "./useShownNotes";

const CONVERSATION_ID = "main";
const NO_VIEWER = () => {};

/**
 * How a resource reaches a screen: the registered artifact of its adapter, the playlist or drawing tab, or the
 * shared-file viewer.
 */
export function useWorkspaceLauncher(
	client: EumenesClient,
	state: Pick<WorkspaceState, "toolchain" | "openPlaylist" | "openDrawing">,
	openScratch: (id: string) => void = NO_VIEWER,
): ResourceLauncher {
	const cache = useQueryClient();
	const { openByAdapter } = state.toolchain;
	const { openPlaylist, openDrawing } = state;
	return useMemo<ResourceLauncher>(
		() => ({
			open: async (adapterRef, targetRef) => {
				if (adapterRef === SCRATCH_ADAPTER_REF) {
					openScratch(targetRef);
					return true;
				}
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
		[cache, client, openByAdapter, openPlaylist, openDrawing, openScratch],
	);
}

/** The resources of the conversation, the way one is opened, and the notice shown when it cannot be. */
export function usePanelResources(
	client: EumenesClient,
	state: WorkspaceState,
) {
	const [scratchId, setScratchId] = useState<string | null>(null);
	const launcher = useWorkspaceLauncher(client, state, setScratchId);
	const notice = useResourceNotice();
	const openResource = useResourceOpener({
		client,
		launcher,
		notify: notice.show,
	});
	const resources = useConversationResources(client, CONVERSATION_ID);
	useShownNotes(
		state.conversation.data?.messages,
		resources.data,
		openResource,
	);
	return {
		resources,
		openResource,
		notice,
		/** The shared file open in the viewer, if any. */
		scratch: { id: scratchId, close: () => setScratchId(null) },
	};
}
