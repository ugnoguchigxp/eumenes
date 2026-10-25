import { ArtifactRenderer } from "@eumenes/artifact-ui";
import type { EumenesClient } from "../../../../../client";
import { useLivePlaylistScreen } from "../../../domains/music/playlist-screen";
import { useLibraryRuntime } from "../../../domains/music/use-library-runtime";
import "./LibraryArtifact.css";
export function LibraryArtifact({
	client,
	definition,
	conversationId,
}: {
	client: EumenesClient;
	definition: string;
	conversationId: string;
}) {
	const {
		runtime,
		loading,
		error,
		retry,
		playlists,
		playlistId,
		selectPlaylist,
		busy,
	} = useLibraryRuntime(client, conversationId, definition);
	const music = Object.values(runtime.snapshot).find((r) => r.kind === "music");
	useLivePlaylistScreen({
		playlistId,
		playableTrackId: music?.tracks.find(
			(t) => t.id === music.currentId && t.url,
		)?.id,
	});
	if (error)
		return (
			<div role="alert">
				<p>プレイリストを取得できませんでした。</p>
				<button
					onClick={() => {
						void retry();
					}}
				>
					再試行
				</button>
			</div>
		);
	if (loading) return <output>プレイリストを準備しています。</output>;
	return (
		<div className="music-library-artifact">
			{playlists.length > 0 && (
				<label className="music-library-playlist-picker">
					保存したプレイリスト
					<select
						value={playlistId}
						disabled={busy}
						onChange={(event) => selectPlaylist(event.target.value)}
					>
						<option value="">すべての曲</option>
						{playlists.map((playlist) => (
							<option key={playlist.id} value={playlist.id}>
								{playlist.title}
							</option>
						))}
					</select>
				</label>
			)}
			<ArtifactRenderer definition={definition} runtime={runtime} />
		</div>
	);
}
