/** Persist only the display definition; the host resolves these sources from its authorized list. */
export function musicArtifactDefinition(id: string) {
	return JSON.stringify({
		view: "layout",
		direction: "grid",
		title: "楽曲とプレイリスト",
		children: [
			{ view: "generation-status", source: `generation-${id}` },
			{ view: "music-player", source: `music-${id}` },
			{ view: "playlist", source: `music-${id}` },
		],
	});
}
