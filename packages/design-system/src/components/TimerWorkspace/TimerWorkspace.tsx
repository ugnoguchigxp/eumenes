import { useId, useState, type CSSProperties } from "react";
import { ArrowUpRight, Play, RotateCcw, Square, Timer } from "lucide-react";
import { Button } from "../Button";
import { Input } from "../Input";
import { DigitalClock } from "../DigitalClock";
import "./TimerWorkspace.css";

export type TimerDraft = {
	hours: string;
	minutes: string;
	seconds: string;
	label: string;
};
export type TimerWorkspaceProps = {
	state: "setup" | "active" | "confirming" | "elapsed" | "cancelled";
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
	onNew?: () => void;
};

const presets = [1, 3, 5, 10, 25];

/** Display and input only. The host owns the clock, persistence and notifications. */
export function TimerWorkspace({
	state,
	title,
	durationSeconds = 180,
	remainingSeconds = 180,
	dueAt,
	finishLabel,
	durationLabel,
	busy = false,
	error,
	onStart,
	onCancel,
	onNew,
}: TimerWorkspaceProps) {
	const id = useId();
	const [draft, setDraft] = useState<TimerDraft>({
		hours: "00",
		minutes: "03",
		seconds: "00",
		label: "",
	});
	const setup = state === "setup";
	const draftSeconds =
		Number(draft.hours) * 3600 +
		Number(draft.minutes) * 60 +
		Number(draft.seconds);
	const progress = setup
		? 1
		: Math.min(1, Math.max(0, remainingSeconds / durationSeconds));
	const status =
		state === "elapsed"
			? "時間になりました"
			: state === "cancelled"
				? "取消済み"
				: state === "confirming"
					? "終了を確認中"
					: "計測中";
	const change = (key: keyof TimerDraft, value: string) =>
		setDraft((current) => ({ ...current, [key]: value }));
	return (
		<section
			className="timer-workspace"
			data-state={state}
			aria-label={setup ? "タイマーの設定" : (title ?? "タイマー")}
		>
			<div className="timer-workspace-inner">
				<header className="timer-workspace-header">
					<div className="timer-workspace-brand">
						<Timer size={16} aria-hidden="true" />
						<span>TIMER</span>
					</div>
					<h2>{setup ? "タイマーを開始" : (title ?? "タイマー")}</h2>
					<p>{setup ? "時間を選んで、スタート。" : (durationLabel ?? "")}</p>
				</header>
				<form
					noValidate
					onSubmit={(event) => {
						event.preventDefault();
						if (setup && !busy) onStart?.(draft);
					}}
				>
					<div className="timer-workspace-dial">
						<svg
							className="timer-workspace-face"
							viewBox="0 0 320 320"
							fill="none"
							aria-hidden="true"
						>
							{Array.from({ length: 60 }, (_, index) => (
								<line
									key={index}
									x1="160"
									y1={index % 5 === 0 ? "9" : "13"}
									x2="160"
									y2="20"
									transform={`rotate(${index * 6} 160 160)`}
									className={
										index % 5 === 0 ? "timer-tick-major" : "timer-tick"
									}
								/>
							))}
							<circle
								className="timer-workspace-track"
								cx="160"
								cy="160"
								r="128"
							/>
							<circle
								className="timer-workspace-ring"
								cx="160"
								cy="160"
								r="128"
								pathLength="100"
								strokeDasharray={`${progress * 100} 100`}
								transform="rotate(-90 160 160)"
							/>
							<circle
								className="timer-workspace-hand"
								cx="160"
								cy="32"
								r="5"
								style={
									{
										transform: `rotate(${progress * 360}deg)`,
										transformOrigin: "160px 160px",
									} as CSSProperties
								}
							/>
						</svg>
						<div className="timer-workspace-dial-content">
							<span className="timer-workspace-caption">
								{setup ? "設定時間" : "残り時間"}
							</span>
							{setup ? (
								<div className="timer-workspace-time-inputs">
									{(
										[
											["hours", "時間"],
											["minutes", "分"],
											["seconds", "秒"],
										] as const
									).map(([key, label], index) => (
										<div className="timer-workspace-time-part" key={key}>
											{index > 0 && (
												<span
													className="timer-workspace-colon"
													aria-hidden="true"
												>
													:
												</span>
											)}
											<label htmlFor={`${id}-${key}`}>
												<input
													id={`${id}-${key}`}
													type="number"
													inputMode="numeric"
													min={0}
													step={1}
													value={draft[key]}
													disabled={busy}
													onFocus={(event) => event.target.select()}
													onChange={(event) => change(key, event.target.value)}
													onBlur={() => {
														if (
															draft[key] &&
															Number.isInteger(Number(draft[key])) &&
															Number(draft[key]) >= 0
														)
															change(key, draft[key].padStart(2, "0"));
													}}
												/>
												<span>{label}</span>
											</label>
										</div>
									))}
								</div>
							) : (
								<DigitalClock
									seconds={remainingSeconds}
									format={durationSeconds >= 3600 ? "hh:mm:ss" : "mm:ss"}
									size="hero"
									className={
										durationSeconds >= 3600
											? "timer-workspace-clock timer-workspace-clock-long"
											: "timer-workspace-clock"
									}
									tone={
										state === "elapsed"
											? "finished"
											: state === "cancelled"
												? "muted"
												: "default"
									}
								/>
							)}
							{setup ? (
								<span className="timer-workspace-dial-hint">
									数字をタップして変更
								</span>
							) : (
								<output className="timer-workspace-status">
									<span aria-hidden="true" />
									{status}
								</output>
							)}
						</div>
					</div>
					{setup ? (
						<div className="timer-workspace-setup">
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
										aria-pressed={draftSeconds === minutes * 60}
										aria-label={`${minutes}分`}
										disabled={busy}
										onClick={() =>
											setDraft((current) => ({
												...current,
												hours: "00",
												minutes: String(minutes).padStart(2, "0"),
												seconds: "00",
											}))
										}
									>
										{minutes}
										<span>分</span>
									</Button>
								))}
							</div>
							<label className="timer-workspace-name" htmlFor={`${id}-label`}>
								<span>
									名前 <span>任意</span>
								</span>
								<Input
									id={`${id}-label`}
									value={draft.label}
									placeholder="例：お茶の時間"
									maxLength={80}
									disabled={busy}
									onChange={(event) => change("label", event.target.value)}
									aria-label="名前（任意）"
								/>
							</label>
							<Button
								type="submit"
								aria-label="開始する"
								className="timer-workspace-primary"
								loading={busy}
							>
								<Play size={17} fill="currentColor" aria-hidden="true" />
								開始する
							</Button>
							<p className="timer-workspace-note">
								時間になったら、音と通知でお知らせします。
							</p>
						</div>
					) : (
						<div className="timer-workspace-running">
							{dueAt && finishLabel && (
								<div className="timer-workspace-finish">
									<span>{state === "elapsed" ? "終了時刻" : "終了予定"}</span>
									<time dateTime={dueAt}>{finishLabel}</time>
									<ArrowUpRight size={15} aria-hidden="true" />
								</div>
							)}
							{(state === "active" || state === "confirming") && onCancel && (
								<Button
									type="button"
									aria-label="取り消す"
									variant="outline"
									className="timer-workspace-primary timer-workspace-stop"
									loading={busy}
									onClick={onCancel}
								>
									<Square size={14} fill="currentColor" aria-hidden="true" />
									取り消す
								</Button>
							)}
							{onNew && (
								<Button
									type="button"
									variant="ghost"
									className="timer-workspace-new"
									disabled={busy}
									onClick={onNew}
								>
									<RotateCcw size={15} aria-hidden="true" />
									新しいタイマー
								</Button>
							)}
						</div>
					)}
					{error && (
						<p className="timer-workspace-error" role="alert">
							{error}
						</p>
					)}
				</form>
			</div>
		</section>
	);
}
