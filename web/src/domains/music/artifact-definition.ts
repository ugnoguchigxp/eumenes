/** Persist only the display definition; the host resolves these sources from its authorized list. */
export function musicArtifactDefinition(id: string) {
	return JSON.stringify({
		view: "music-workspace",
		source: `music-${id}`,
		title: "楽曲生成",
	});
}

export function playlistArtifactDefinition(id: string) {
	return JSON.stringify({
		view: "music-workspace",
		source: `library-${id}`,
		title: "プレイリスト",
	});
}
