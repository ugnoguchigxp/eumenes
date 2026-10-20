import { useState } from "react";
import { Button } from "../Button";
import type { PlaylistTrack } from "../MusicPlayer";
import { formatClockSeconds } from "../DigitalClock/format";

export function MusicTrackDetails({
	track,
	busy,
	onDelete,
	download,
}: {
	track: PlaylistTrack;
	busy?: boolean;
	onDelete?: (id: string) => void;
	download?: { url: string; name?: string };
}) {
	const [confirming, setConfirming] = useState(false);
	return (
		<div className="music-track-details">
			<h3>{track.title}</h3>
			<dl>
				<dt>長さ</dt>
				<dd>
					{track.durationSeconds === undefined
						? "不明"
						: Number.isInteger(track.durationSeconds)
							? formatClockSeconds(track.durationSeconds)
							: `${track.durationSeconds}秒`}
				</dd>
				{track.subtitle && (
					<>
						<dt>説明</dt>
						<dd>{track.subtitle}</dd>
					</>
				)}
				{track.prompt && track.prompt !== track.subtitle && (
					<>
						<dt>生成指示</dt>
						<dd>{track.prompt}</dd>
					</>
				)}
				<dt>タグ</dt>
				<dd>{track.tags?.length ? track.tags.join(" · ") : "タグなし"}</dd>
				{track.task && (
					<>
						<dt>用途</dt>
						<dd>
							{track.task === "sound-effect"
								? "効果音"
								: track.instrumental
									? "歌なし音楽"
									: "ボーカル"}
						</dd>
					</>
				)}
				{track.runtime && (
					<>
						<dt>Runtime</dt>
						<dd>{track.runtime}</dd>
					</>
				)}
				<dt>歌詞</dt>
				<dd>
					{track.task === "sound-effect"
						? "効果音のため歌詞はありません。"
						: track.lyrics ||
							(track.instrumental
								? "インストゥルメンタルのため歌詞はありません。"
								: "歌詞の情報はありません。")}
				</dd>
				{track.model && (
					<>
						<dt>モデル</dt>
						<dd>{track.model}</dd>
					</>
				)}
				{track.format && (
					<>
						<dt>形式</dt>
						<dd>{track.format}</dd>
					</>
				)}
				{track.createdAt && (
					<>
						<dt>作成日</dt>
						<dd>
							<time dateTime={track.createdAt}>
								{new Date(track.createdAt).toLocaleString()}
							</time>
						</dd>
					</>
				)}
			</dl>
			<div className="music-track-details-actions">
				{download && (
					<a href={download.url} download={download.name ?? "music"}>
						{track.task === "sound-effect" ? "効果音を保存" : "楽曲を保存"}
					</a>
				)}
				{onDelete && (
					<Button
						variant="outline"
						disabled={busy}
						aria-label={`${track.title}を削除`}
						onClick={() => setConfirming(true)}
					>
						削除
					</Button>
				)}
			</div>
			{confirming && onDelete && (
				<div role="group" aria-label="楽曲削除の確認">
					<p>「{track.title}」の音声と履歴を削除しますか？</p>
					<Button disabled={busy} onClick={() => onDelete(track.id)}>
						削除する
					</Button>
					<Button onClick={() => setConfirming(false)}>戻る</Button>
				</div>
			)}
		</div>
	);
}
