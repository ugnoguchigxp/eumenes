import { useState } from "react";
import { Play, RotateCcw, Square } from "lucide-react";
import { Button } from "../Button";
import { DigitalClock } from "../DigitalClock";
import { ClockDial } from "./ClockDial";
import { TimerDurationFields } from "./TimerDurationFields";
import type { TimerDraft, TimerWorkspaceProps } from "./TimerWorkspace";

const presets = [1, 3, 5, 10, 25];
function durationFields(seconds: number): TimerDraft {
	return {
		hours: String(Math.floor(seconds / 3600)).padStart(2, "0"),
		minutes: String(Math.floor((seconds % 3600) / 60)).padStart(2, "0"),
		seconds: String(seconds % 60).padStart(2, "0"),
	};
}

export function TimerPane({
	state,
	title,
	durationSeconds = 180,
	remainingSeconds = 180,
	dueAt,
	finishLabel,
	busy,
	error,
	onStart,
	onCancel,
	onPause,
	onResume,
	onNew,
}: TimerWorkspaceProps) {
	const [draft, setDraft] = useState<TimerDraft>(() => durationFields(180));
	const setup = state === "setup";
	const draftSeconds =
		Number(draft.hours) * 3600 +
		Number(draft.minutes) * 60 +
		Number(draft.seconds);
	const seconds = setup
		? Number.isFinite(draftSeconds)
			? Math.max(0, draftSeconds)
			: 0
		: remainingSeconds;
	const value = setup ? draft : durationFields(durationSeconds);
	const status =
		state === "setup"
			? "開始待ち"
			: state === "elapsed"
				? "時間になりました"
				: state === "cancelled"
					? "取消済み"
					: state === "paused"
						? "停止中"
						: state === "confirming"
							? "終了を確認中"
							: "計測中";
	const running = state === "active" || state === "confirming";
	const resumable =
		(state === "paused" || state === "cancelled") && remainingSeconds > 0;
	const operation = setup
		? onStart
		: running
			? (onPause ?? onCancel)
			: resumable
				? onResume
				: undefined;
	const actionLabel = setup
		? "開始する"
		: running
			? onPause
				? "停止する"
				: "取り消す"
			: resumable
				? "再開する"
				: "開始する";
	return (
		<form
			noValidate
			onSubmit={(event) => {
				event.preventDefault();
				if (setup && !busy) onStart?.(draft);
			}}
		>
			<div className="timer-workspace-main">
				<ClockDial progress={setup ? 1 : remainingSeconds / durationSeconds}>
					<span className="timer-workspace-caption">{title ?? "残り時間"}</span>
					<DigitalClock
						seconds={seconds}
						format="hh:mm:ss"
						size="hero"
						className="timer-workspace-clock timer-workspace-clock-long"
						tone={
							state === "elapsed"
								? "finished"
								: state === "cancelled"
									? "muted"
									: "default"
						}
					/>
					<TimerDurationFields
						value={value}
						disabled={busy}
						readOnly={!setup}
						onChange={(key, value) =>
							setDraft((current) => ({ ...current, [key]: value }))
						}
					/>
					<output className="timer-workspace-status">
						<span aria-hidden="true" />
						{status}
					</output>
					<div className="timer-workspace-finish">
						{dueAt && finishLabel && state !== "paused" && (
							<>
								<span>{state === "elapsed" ? "終了時刻" : "終了予定"}</span>
								<time dateTime={dueAt}>{finishLabel}</time>
							</>
						)}
					</div>
				</ClockDial>
				<div
					className="timer-workspace-presets"
					role="group"
					aria-label="よく使う時間"
				>
					{presets.map((minutes) => (
						<Button
							key={minutes}
							type="button"
							variant="ghost"
							aria-pressed={
								(setup ? draftSeconds : durationSeconds) === minutes * 60
							}
							aria-label={`${minutes}分`}
							disabled={busy || !setup}
							onClick={() => setDraft(durationFields(minutes * 60))}
						>
							{minutes}
							<span>分</span>
						</Button>
					))}
				</div>
				<div className="timer-workspace-actions">
					<Button
						type={setup ? "submit" : "button"}
						aria-label={actionLabel}
						variant={running ? "outline" : "default"}
						className="timer-workspace-primary"
						loading={busy}
						disabled={!operation}
						onClick={
							setup
								? undefined
								: () => {
										if (running) (onPause ?? onCancel)?.();
										else if (resumable) onResume?.();
									}
						}
					>
						{running ? (
							<Square size={13} fill="currentColor" aria-hidden="true" />
						) : (
							<Play size={15} fill="currentColor" aria-hidden="true" />
						)}
						{actionLabel}
					</Button>
					<Button
						type="button"
						variant="ghost"
						className="timer-workspace-new"
						disabled={busy || setup || !onNew}
						onClick={onNew}
					>
						<RotateCcw size={14} aria-hidden="true" />
						新しいタイマー
					</Button>
				</div>
			</div>
			{error && (
				<p className="timer-workspace-error" role="alert">
					{error}
				</p>
			)}
		</form>
	);
}
