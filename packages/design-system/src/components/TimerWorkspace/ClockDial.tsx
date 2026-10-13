import type { ReactNode } from "react";

/** A shared clock face driven entirely by a host-supplied fraction. */
export function ClockDial({
	progress,
	children,
}: {
	progress: number;
	children: ReactNode;
}) {
	const fraction = Math.min(1, Math.max(0, progress));
	return (
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
						className={index % 5 === 0 ? "timer-tick-major" : "timer-tick"}
					/>
				))}
				<circle className="timer-workspace-track" cx="160" cy="160" r="128" />
				<circle
					className="timer-workspace-ring"
					cx="160"
					cy="160"
					r="128"
					pathLength="100"
					strokeDasharray={`${fraction * 100} 100`}
					transform="rotate(-90 160 160)"
				/>
				<circle
					className="timer-workspace-hand"
					cx="160"
					cy="32"
					r="5"
					style={{
						transform: `rotate(${fraction * 360}deg)`,
						transformOrigin: "160px 160px",
					}}
				/>
			</svg>
			<div className="timer-workspace-dial-content">{children}</div>
		</div>
	);
}
