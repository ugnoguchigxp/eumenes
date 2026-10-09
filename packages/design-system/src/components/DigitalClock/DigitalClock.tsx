import { clockAccessibleLabel, formatClockSeconds } from "./format";
import "./DigitalClock.css";

export type DigitalClockProps = {
	seconds: number;
	format?: "mm:ss" | "hh:mm:ss" | "auto";
	size?: "sm" | "md" | "lg" | "hero";
	tone?: "default" | "warning" | "finished" | "muted";
	label?: string;
	className?: string;
};

export function DigitalClock({
	seconds,
	format = "auto",
	size = "md",
	tone = "default",
	label,
	className,
}: DigitalClockProps) {
	const text = formatClockSeconds(seconds, format);
	return (
		<div
			className={["digital-clock", `digital-clock-${size}`, `digital-clock-${tone}`, className]
				.filter(Boolean)
				.join(" ")}
			role="timer"
			aria-live="off"
			aria-label={label ?? clockAccessibleLabel(seconds)}
		>
			<span className="digital-clock-digits">{text}</span>
		</div>
	);
}
