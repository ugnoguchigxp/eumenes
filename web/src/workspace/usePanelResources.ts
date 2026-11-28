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
import {
	prepareToolchainAdapter,
	toolchainWebAdapters,
} from "./toolchain-adapters";
import type { WorkspaceState } from "./useWorkspace";
import { useShownNotes } from "./useShownNotes";
import { prototypeScreenRef } from "../../../api/domains/prototype/contracts";
import { worksScreen } from "../domains/prototype/resource-screen";

const CONVERSATION_ID = "main";
const NO_VIEWER = () => {};

/**
 * How a resource reaches a screen: the registered artifact of its adapter, the playlist or drawing tab, or the
 * shared-file viewer.
 */
export function useWorkspaceLauncher(
	state: Pick<WorkspaceState, "toolchain" | "openPlaylist" | "openDrawing">,
	openScratch: (id: string) => void = NO_VIEWER,
): ResourceLauncher {
	const { openByAdapter } = state.toolchain;
	const { openPlaylist, openDrawing } = state;
	return useMemo<ResourceLauncher>(
		() => ({
			open: async (adapterRef, targetRef) => {
				if (adapterRef === prototypeScreenRef)
					return worksScreen.focus(targetRef);
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
				if (!(await openByAdapter(adapterRef, targetRef))) return false;
				return (await prepareToolchainAdapter(adapterRef)) !== "unavailable";
			},
			screen: (adapterRef) =>
				adapterRef === MUSIC_PLAYLIST_ADAPTER_REF
					? musicPlaylistScreen
					: adapterRef === DRAWING_ADAPTER_REF
						? drawingScreen
						: toolchainWebAdapters.get(adapterRef),
		}),
		[openByAdapter, openPlaylist, openDrawing, openScratch],
	);
}

/** The resources of the conversation, the way one is opened, and the notice shown when it cannot be. */
export function usePanelResources(
	client: EumenesClient,
	state: WorkspaceState,
) {
	const [scratchId, setScratchId] = useState<string | null>(null);
	const launcher = useWorkspaceLauncher(state, setScratchId);
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
