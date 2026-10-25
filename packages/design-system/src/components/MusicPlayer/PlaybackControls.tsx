import {
	Pause,
	Play,
	Repeat1,
	RotateCcw,
	RotateCw,
	SkipBack,
	SkipForward,
} from "lucide-react";
import { cn } from "../../utils/cn";
import { Button } from "../Button";

export function PlaybackControls({
	playing,
	seekable,
	onToggle,
	onSeekBack,
	onSeekForward,
	onPrevious,
	onNext,
	repeat,
	onRepeatChange,
	attention,
}: {
	playing: boolean;
	seekable: boolean;
	onToggle: () => void;
	onSeekBack: () => void;
	onSeekForward: () => void;
	onPrevious?: () => void;
	onNext?: () => void;
	repeat: boolean;
	onRepeatChange: (repeat: boolean) => void;
	/** Playback was refused without a user gesture: the play button asks to be pressed. */
	attention?: boolean;
}) {
	return (
		<fieldset className="music-player-controls" aria-label="再生操作">
			<Button
				type="button"
				variant="ghost"
				size="icon"
				aria-label="前の楽曲"
				disabled={!onPrevious}
				onClick={onPrevious}
			>
				<SkipBack aria-hidden="true" />
			</Button>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				aria-label="10秒巻き戻し"
				disabled={!seekable}
				onClick={onSeekBack}
			>
				<span className="music-player-skip">
					<RotateCcw aria-hidden="true" />
					<small>10</small>
				</span>
			</Button>
			<Button
				type="button"
				size="icon"
				className={cn(
					"music-player-toggle",
					attention && "music-player-attention",
				)}
				aria-label={playing ? "一時停止" : "再生"}
				onClick={onToggle}
			>
				{playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
			</Button>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				aria-label="10秒スキップ"
				disabled={!seekable}
				onClick={onSeekForward}
			>
				<span className="music-player-skip">
					<RotateCw aria-hidden="true" />
					<small>10</small>
				</span>
			</Button>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				aria-label="次の楽曲"
				disabled={!onNext}
				onClick={onNext}
			>
				<SkipForward aria-hidden="true" />
			</Button>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				className="music-player-repeat"
				aria-label="1曲リピート"
				aria-pressed={repeat}
				onClick={() => onRepeatChange(!repeat)}
			>
				<Repeat1 aria-hidden="true" />
			</Button>
		</fieldset>
	);
}
