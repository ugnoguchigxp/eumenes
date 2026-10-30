import { Music2, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../utils/cn";
import { formatClockSeconds } from "../DigitalClock/format";
import { PlaybackControls } from "./PlaybackControls";
import { registerPlayer } from "./playbackRequest";
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
	const [resume, setResume] = useState(false);
	const [repeat, setRepeat] = useState(false);
	const [volume, setVolume] = useState(1);
	if (!props.track) {
		if (!props.loading && resume) setResume(false);
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
			autoPlay={resume}
			repeat={repeat}
			volume={volume}
			onVolumeChange={setVolume}
			onRepeatChange={setRepeat}
			onPlayingChange={(playing) => {
				setResume(playing);
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
	repeat,
	onRepeatChange,
	onPlayingChange,
	volume,
	onVolumeChange,
}: MusicPlayerProps & {
	track: MusicTrack;
	autoPlay: boolean;
	repeat: boolean;
	onRepeatChange: (repeat: boolean) => void;
	onPlayingChange: (playing: boolean) => void;
	volume: number;
	onVolumeChange: (volume: number) => void;
}) {
	const { ref: audioRef, ...playback } = usePlayback(
		autoPlay,
		volume,
		onVolumeChange,
		!!onPlaybackChange,
	);
	// A request from code that the browser refused: the play button asks to be pressed.
	const [refused, setRefused] = useState(false);
	const startRef = useRef(playback.start);
	useEffect(() => {
		startRef.current = playback.start;
	});
	useEffect(
		() =>
			registerPlayer({
				trackId: track.id,
				start: async () => {
					try {
						await startRef.current();
						setRefused(false);
					} catch (error) {
						if (
							error instanceof DOMException &&
							error.name === "NotAllowedError"
						)
							setRefused(true);
						throw error;
					}
				},
			}),
		[track.id],
	);
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
				ref={audioRef}
				src={track.src}
				preload="metadata"
				loop={repeat}
				{...playback.events}
				onPlay={() => {
					playback.events.onPlay();
					onPlayingChange(true);
				}}
				onPause={() => {
					playback.events.onPause();
					// Media fires pause before ended; the end decides the playing intent.
					if (!audioRef.current?.ended) onPlayingChange(false);
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
				repeat={repeat}
				onRepeatChange={onRepeatChange}
				attention={refused && !playback.playing}
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
