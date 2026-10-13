import { Play, RotateCcw, Square } from "lucide-react";
import { Button } from "../Button";
import { DigitalClock } from "../DigitalClock";
import { ClockDial } from "./ClockDial";
import type { TimerWorkspaceProps } from "./TimerWorkspace";

/** Stopwatch presentation only; elapsed time and controls come from the host. */
export function StopwatchPane({
	stopwatch,
	busy,
	onStopwatchStart,
	onStopwatchStop,
	onStopwatchReset,
}: TimerWorkspaceProps) {
	const elapsedMs = Math.max(0, stopwatch?.elapsedMs ?? 0);
	const running = stopwatch?.running ?? false;
	const long = elapsedMs >= 3600000;
	const fraction = Math.floor((elapsedMs % 1000) / 10)
		.toString()
		.padStart(2, "0");
	return (
		<div className="stopwatch-workspace">
			<div className="timer-workspace-main timer-workspace-main-running">
				<ClockDial progress={(elapsedMs % 60000) / 60000}>
					<span className="timer-workspace-caption">経過時間</span>
					<DigitalClock
						seconds={elapsedMs / 1000}
						format={long ? "hh:mm:ss" : "mm:ss"}
						size="hero"
						className={`timer-workspace-clock${long ? " timer-workspace-clock-long" : ""}`}
						label="ストップウォッチの経過時間"
					/>
					<span className="stopwatch-workspace-fraction" aria-hidden="true">
						.{fraction}
					</span>
					<output className="timer-workspace-status">
						<span aria-hidden="true" />
						{running ? "計測中" : elapsedMs > 0 ? "停止中" : "開始待ち"}
					</output>
				</ClockDial>
			</div>
			<div className="timer-workspace-actions">
				<Button
					type="button"
					aria-label={
						running ? "停止する" : elapsedMs > 0 ? "再開する" : "開始する"
					}
					variant={running ? "outline" : "default"}
					className="timer-workspace-primary"
					disabled={busy}
					onClick={running ? onStopwatchStop : onStopwatchStart}
				>
					{running ? (
						<Square size={13} fill="currentColor" aria-hidden="true" />
					) : (
						<Play size={15} fill="currentColor" aria-hidden="true" />
					)}
					{running ? "停止する" : elapsedMs > 0 ? "再開する" : "開始する"}
				</Button>
				<Button
					type="button"
					variant="ghost"
					className="timer-workspace-new"
					disabled={busy || running || elapsedMs === 0}
					onClick={onStopwatchReset}
				>
					<RotateCcw size={14} aria-hidden="true" />
					リセット
				</Button>
			</div>
		</div>
	);
}
