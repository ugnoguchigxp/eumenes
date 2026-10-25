import { useCallback } from "react";
import { drawingDefinition } from "../domains/excalidraw/drawing-definition";
import { playlistArtifactDefinition } from "../domains/music/artifact-definition";
import type { useArtifactWorkspace } from "../domains/artifact";

export function useOpenDrawing(
	open: ReturnType<typeof useArtifactWorkspace>["open"],
) {
	return useCallback(
		() =>
			open({
				id: "drawing-workspace",
				kind: "openui",
				title: "図を描く・編集する",
				definition: drawingDefinition,
				keepMounted: true,
			}),
		[open],
	);
}
/**
 * The one playlist screen: it shows the playlist `id` names, or the latest/chosen one without it.
 * The launcher passes its click event as the first argument, which is not an id.
 */
export function useOpenPlaylist(
	open: ReturnType<typeof useArtifactWorkspace>["open"],
) {
	return useCallback(
		(id?: unknown) =>
			open({
				id: "music-playlist",
				kind: "openui",
				definition: playlistArtifactDefinition(
					typeof id === "string" && id ? id : undefined,
				),
				title: "音楽プレイリスト",
			}),
		[open],
	);
}
