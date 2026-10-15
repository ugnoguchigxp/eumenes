import { Star } from "lucide-react";
import { Button } from "../Button";
import { formatClockSeconds } from "../DigitalClock/format";
import type { MusicPlaybackState, PlaylistTrack } from "../MusicPlayer";

export function MusicCurrentTrack({
	current,
	activePlayback,
	busy,
	onFavorite,
	openDetail,
}: {
	current: PlaylistTrack | undefined;
	activePlayback: MusicPlaybackState | null;
	busy?: boolean;
	onFavorite?: (id: string, favorite: boolean) => void;
	openDetail: (id: string) => void;
}) {
	return (
		<div className="music-workspace-current">
			<span className="music-workspace-status">
				{activePlayback?.playing ? "再生中" : "選択中"}
			</span>
			<div className="music-workspace-title">
				{current && onFavorite && (
					<Button
						size="icon"
						variant="ghost"
						className="music-workspace-favorite"
						aria-pressed={!!current.favorite}
						disabled={busy}
						aria-label={`${current.title}を${current.favorite ? "お気に入りから解除" : "お気に入り登録"}`}
						onClick={() => onFavorite(current.id, !current.favorite)}
					>
						<Star
							aria-hidden="true"
							fill={current.favorite ? "currentColor" : "none"}
						/>
					</Button>
				)}
				<h3>{current?.title ?? "楽曲を選択してください"}</h3>
			</div>
			<div className="music-workspace-current-meta">
				<span>
					{formatClockSeconds(activePlayback?.position ?? 0)} /{" "}
					{formatClockSeconds(
						activePlayback?.duration || current?.durationSeconds || 0,
					)}
				</span>
				{current && (
					<Button
						size="sm"
						variant="outline"
						onClick={() => openDetail(current.id)}
					>
						詳細
					</Button>
				)}
			</div>
		</div>
	);
}
