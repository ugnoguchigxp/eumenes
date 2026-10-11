import { useState } from "react";
import { Button } from "../Button";
import { cn } from "../../utils/cn";
import { formatClockSeconds } from "../DigitalClock/format";
import type { PlaylistTrack } from "../MusicPlayer/types";
import "./Playlist.css";

export type PlaylistProps = {
	tracks: readonly PlaylistTrack[];
	currentTrackId?: string;
	onSelect: (id: string) => void;
	onFavorite?: (id: string, favorite: boolean) => void;
	onDelete?: (id: string) => void;
	busy?: boolean;
	title?: string;
	className?: string;
	compact?: boolean;
	onDetail?: (id: string) => void;
};

export function Playlist({
	tracks,
	currentTrackId,
	onSelect,
	onFavorite,
	onDelete,
	busy,
	title = "プレイリスト",
	className,
	compact,
	onDetail,
}: PlaylistProps) {
	const [deleting, setDeleting] = useState<string>();
	return (
		<section
			className={cn(
				"music-playlist",
				compact && "music-playlist-compact",
				className,
			)}
			aria-label={title}
		>
			<h3 className={compact ? "sr-only" : undefined}>{title}</h3>
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
									{!compact && track.subtitle && (
										<small>{track.subtitle}</small>
									)}
									{!compact && track.createdAt && (
										<small>
											<time dateTime={track.createdAt}>
												{new Date(track.createdAt).toLocaleString()}
											</time>
										</small>
									)}
									{!compact && !!track.tags?.length && (
										<small>{track.tags.join(" · ")}</small>
									)}
								</span>
								{track.durationSeconds !== undefined && (
									<span className="music-playlist-time">
										{formatClockSeconds(track.durationSeconds)}
									</span>
								)}
							</button>
							{onDetail && (
								<Button
									size="sm"
									variant="outline"
									onClick={() => onDetail(track.id)}
									aria-label={`${track.title}の詳細`}
								>
									詳細
								</Button>
							)}
							{onFavorite && (
								<Button
									disabled={busy}
									aria-label={`${track.title}を${track.favorite ? "お気に入りから解除" : "お気に入り登録"}`}
									onClick={() => onFavorite(track.id, !track.favorite)}
								>
									{track.favorite ? "★" : "☆"}
								</Button>
							)}
							{onDelete &&
								(deleting === track.id ? (
									<div role="group" aria-label="楽曲削除の確認">
										<p>「{track.title}」の音声と履歴を削除しますか？</p>
										<Button
											disabled={busy}
											onClick={() => {
												onDelete(track.id);
												setDeleting(undefined);
											}}
										>
											削除する
										</Button>
										<Button onClick={() => setDeleting(undefined)}>戻る</Button>
									</div>
								) : (
									<Button
										disabled={busy}
										aria-label={`${track.title}を削除`}
										onClick={() => setDeleting(track.id)}
									>
										削除
									</Button>
								))}
						</li>
					))}
				</ol>
			)}
		</section>
	);
}
