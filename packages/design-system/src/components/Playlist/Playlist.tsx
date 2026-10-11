import { cn } from "../../utils/cn";
import { formatClockSeconds } from "../DigitalClock/format";
import type { PlaylistTrack } from "../MusicPlayer/types";
import "./Playlist.css";

export type PlaylistProps = {
	tracks: readonly PlaylistTrack[];
	currentTrackId?: string;
	onSelect: (id: string) => void;
	title?: string;
	className?: string;
};

export function Playlist({
	tracks,
	currentTrackId,
	onSelect,
	title = "プレイリスト",
	className,
}: PlaylistProps) {
	return (
		<section className={cn("music-playlist", className)} aria-label={title}>
			<h3>{title}</h3>
			{tracks.length === 0 ? (
				<p>楽曲はまだありません。</p>
			) : (
				<ol>
					{tracks.map((track, index) => (
						<li key={track.id}>
							<button
								type="button"
								className="music-playlist-row"
								aria-current={track.id === currentTrackId ? "true" : undefined}
								disabled={track.disabled}
								onClick={() => onSelect(track.id)}
							>
								<span className="music-playlist-number" aria-hidden="true">
									{index + 1}
								</span>
								<span className="music-playlist-copy">
									<span>{track.title}</span>
									{track.subtitle && <small>{track.subtitle}</small>}
								</span>
								{track.durationSeconds !== undefined && (
									<span className="music-playlist-time">
										{formatClockSeconds(track.durationSeconds)}
									</span>
								)}
							</button>
						</li>
					))}
				</ol>
			)}
		</section>
	);
}
