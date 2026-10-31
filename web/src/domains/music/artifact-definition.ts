/** Persist only the display definition; the host resolves these sources from its authorized list. */
export const musicStudioSource = "music-studio";
export const playlistStudioSource = "library-studio";

export function playlistArtifactDefinition(id?: string) {
	return JSON.stringify({
		view: "music-workspace",
		source: id === undefined ? playlistStudioSource : `library-${id}`,
		title: "音楽プレイリスト",
	});
}
