import { Button } from "../Button";
import { TimerPane } from "./TimerPane";
import { StopwatchPane } from "./StopwatchPane";
import "./TimerWorkspace.css";

export type TimerDraft = { hours: string; minutes: string; seconds: string };
export type ClockMode = "timer" | "stopwatch";
export type TimerWorkspaceProps = {
	state: "setup" | "active" | "paused" | "confirming" | "elapsed" | "cancelled";
	title?: string;
	durationSeconds?: number;
	remainingSeconds?: number;
	dueAt?: string;
	finishLabel?: string;
	durationLabel?: string;
	busy?: boolean;
	error?: string;
	onStart?: (draft: TimerDraft) => void;
	onCancel?: () => void;
	onPause?: () => void;
	onResume?: () => void;
	onNew?: () => void;
	mode?: ClockMode;
	stopwatch?: { elapsedMs: number; running: boolean };
	onModeChange?: (mode: ClockMode) => void;
	onStopwatchStart?: () => void;
	onStopwatchStop?: () => void;
	onStopwatchReset?: () => void;
};

/** Both panes share display primitives; the host owns every clock and operation. */
export function TimerWorkspace(props: TimerWorkspaceProps) {
	const mode = props.mode ?? "timer";
	const title = mode === "stopwatch" ? "ストップウォッチ" : "タイマー";
	return (
		<section
			className="timer-workspace"
			data-state={mode === "stopwatch" ? "setup" : props.state}
			aria-label={
				mode === "stopwatch"
					? "ストップウォッチ"
					: props.state === "setup"
						? "タイマーの設定"
						: (props.title ?? "タイマー")
			}
		>
			<div className="timer-workspace-inner">
				<header className="timer-workspace-header">
					<h2>{title}</h2>
					{props.stopwatch && (
						<div
							role="group"
							aria-label="時計の種類"
							className="timer-workspace-modes"
						>
							{(["timer", "stopwatch"] as const).map((value) => (
								<Button
									key={value}
									type="button"
									variant={mode === value ? "default" : "outline"}
									aria-pressed={mode === value}
									disabled={props.busy}
									onClick={() => props.onModeChange?.(value)}
								>
									{value === "timer" ? "タイマー" : "ストップウォッチ"}
								</Button>
							))}
						</div>
					)}
				</header>
				<div hidden={mode !== "timer"} className="timer-workspace-pane">
					<TimerPane {...props} />
				</div>
				<div hidden={mode !== "stopwatch"} className="timer-workspace-pane">
					<StopwatchPane {...props} />
				</div>
			</div>
		</section>
	);
}
