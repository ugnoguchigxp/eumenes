import { Music2, Volume2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "../../utils/cn";
import { formatClockSeconds } from "../DigitalClock/format";
import { PlaybackControls } from "./PlaybackControls";
import type { MusicTrack, MusicPlaybackState } from "./types";
import { usePlayback } from "./usePlayback";
import "./MusicPlayer.css";

export type MusicPlayerProps = {
	track: MusicTrack | null;
	onPrevious?: () => void;
	onNext?: () => void;
	/** Host chooses whether reaching the end should advance the playlist. */
	onEnded?: () => void;
	className?: string;
	compact?: boolean;
	/** A selected track is being loaded; retain the preceding playback intent. */
	loading?: boolean;
	onPlaybackChange?: (state: MusicPlaybackState) => void;
};

export function MusicPlayer(props: MusicPlayerProps) {
	const resume = useRef(false);
	if (!props.track) {
		if (!props.loading) resume.current = false;
		return (
			<section
				className={cn(
					"music-player",
					"music-player-empty",
					props.compact && "music-player-compact",
					props.className,
				)}
				aria-label="音楽プレイヤー"
			>
				<Music2 aria-hidden="true" />
				<p>
					{props.loading
						? "楽曲を読み込んでいます。"
						: "楽曲を選択してください。"}
				</p>
			</section>
		);
	}
	return (
		<Player
			key={`${props.track.id}:${props.track.src}`}
			{...props}
			track={props.track}
			autoPlay={resume.current}
			onPlayingChange={(playing) => {
				resume.current = playing;
			}}
		/>
	);
}

function Player({
	track,
	onPrevious,
	onNext,
	onEnded,
	className,
	compact,
	onPlaybackChange,
	autoPlay,
	onPlayingChange,
}: MusicPlayerProps & {
	track: MusicTrack;
	autoPlay: boolean;
	onPlayingChange: (playing: boolean) => void;
}) {
	const playback = usePlayback(autoPlay, !!onPlaybackChange);
	useEffect(() => {
		onPlaybackChange?.({
			id: track.id,
			playing: playback.playing,
			position: playback.position,
			duration: playback.duration,
			analyser: playback.analyser,
			analysisError: playback.analysisError,
		});
	}, [
		track.id,
		onPlaybackChange,
		playback.playing,
		playback.position,
		playback.duration,
		playback.analyser,
		playback.analysisError,
	]);
	return (
		<section
			className={cn(
				"music-player",
				compact && "music-player-compact",
				className,
			)}
			aria-label="音楽プレイヤー"
		>
			<div
				className={cn("music-player-art", compact && "sr-only")}
				aria-hidden="true"
			>
				<Music2 />
			</div>
			<div className="music-player-heading">
				<h3>{track.title}</h3>
				{!compact && track.subtitle && <p>{track.subtitle}</p>}
			</div>
			{/* Audio-only generated music; no video caption track. */}
			{/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
			<audio
				ref={playback.ref}
				src={track.src}
				preload="metadata"
				{...playback.events}
				onPlay={() => {
					playback.events.onPlay();
					onPlayingChange(true);
				}}
				onPause={() => {
					playback.events.onPause();
					onPlayingChange(false);
				}}
				onEnded={() => {
					if (onEnded) onEnded();
					else onPlayingChange(false);
				}}
			/>
			<div className="music-player-timeline">
				<input
					type="range"
					aria-label="再生位置"
					aria-valuetext={`${formatClockSeconds(playback.position)} / ${formatClockSeconds(playback.duration)}`}
					min={0}
					max={playback.duration || 1}
					step={0.1}
					value={Math.min(playback.position, playback.duration)}
					disabled={!playback.duration}
					onChange={(event) => playback.seek(Number(event.target.value))}
				/>
				<div>
					<span>{formatClockSeconds(playback.position)}</span>
					<span>{formatClockSeconds(playback.duration)}</span>
				</div>
			</div>
			<PlaybackControls
				playing={playback.playing}
				seekable={playback.duration > 0}
				onToggle={() => {
					void playback.toggle();
				}}
				onSeekBack={() => playback.seek(playback.position - 10)}
				onSeekForward={() => playback.seek(playback.position + 10)}
				onPrevious={onPrevious}
				onNext={onNext}
			/>
			<label className="music-player-volume">
				<Volume2 aria-hidden="true" />
				<span className="sr-only">音量</span>
				<input
					type="range"
					min={0}
					max={1}
					step={0.01}
					value={playback.volume}
					onChange={(event) => playback.setVolume(Number(event.target.value))}
				/>
			</label>
			{playback.error && (
				<p role="alert">
					音声を再生できませんでした。再生ボタンから再試行できます。
				</p>
			)}
		</section>
	);
}
