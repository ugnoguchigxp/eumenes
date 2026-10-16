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
export function useOpenPlaylist(
	open: ReturnType<typeof useArtifactWorkspace>["open"],
) {
	return useCallback(
		() =>
			open({
				id: "music-playlist",
				kind: "openui",
				definition: playlistArtifactDefinition(),
				title: "音楽プレイリスト",
			}),
		[open],
	);
}
