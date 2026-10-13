import { useCallback, useEffect, useState } from "react";

type StopwatchState = { accumulatedMs: number; startedAt: number | null };
const idle: StopwatchState = { accumulatedMs: 0, startedAt: null };
function elapsedAt(state: StopwatchState, now: number) {
	return (
		state.accumulatedMs +
		(state.startedAt === null ? 0 : Math.max(0, now - state.startedAt))
	);
}

/** Monotonic elapsed time; sampling only repaints the visible clock. */
export function useStopwatch(visible: boolean) {
	const [state, setState] = useState(idle);
	const [sample, setSample] = useState(() => performance.now());
	const running = state.startedAt !== null;
	useEffect(() => {
		if (!visible || !running) return;
		const interval = window.setInterval(() => setSample(performance.now()), 50);
		return () => window.clearInterval(interval);
	}, [visible, running]);
	const start = useCallback(() => {
		const now = performance.now();
		setSample(now);
		setState((current) =>
			current.startedAt !== null ? current : { ...current, startedAt: now },
		);
	}, []);
	const stop = useCallback(() => {
		const now = performance.now();
		setState((current) =>
			current.startedAt === null
				? current
				: {
						accumulatedMs: elapsedAt(current, now),
						startedAt: null,
					},
		);
	}, []);
	const reset = useCallback(
		() =>
			setState((current) =>
				current.startedAt === null && current.accumulatedMs === 0
					? current
					: idle,
			),
		[],
	);
	return {
		running,
		elapsedMs: elapsedAt(state, Math.max(sample, state.startedAt ?? sample)),
		start,
		stop,
		reset,
	};
}
