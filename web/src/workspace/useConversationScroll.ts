import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Follow layout changes until the reader scrolls up; never move keyboard focus. */
export function useConversationScroll() {
	const historyRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const followLatest = useRef(true);
	const lastTop = useRef(0);
	const lastSize = useRef({ height: 0, viewport: 0 });
	const frame = useRef<number | null>(null);
	const [showLatest, setShowLatest] = useState(false);
	const align = useCallback(() => {
		const history = historyRef.current;
		if (!history || !history.clientHeight) return;
		const bottom = Math.max(0, history.scrollHeight - history.clientHeight);
		if (Math.abs(history.scrollTop - bottom) > 1) history.scrollTop = bottom;
		lastTop.current = history.scrollTop;
		lastSize.current = {
			height: history.scrollHeight,
			viewport: history.clientHeight,
		};
	}, []);
	const followLatestIfPinned = useCallback(() => {
		if (!followLatest.current || frame.current !== null) return;
		frame.current = requestAnimationFrame(() => {
			frame.current = null;
			if (followLatest.current) align();
		});
	}, [align]);
	const pause = useCallback(() => {
		if (!followLatest.current) return;
		followLatest.current = false;
		setShowLatest(true);
	}, []);
	const scrollLatest = useCallback(() => {
		followLatest.current = true;
		setShowLatest(false);
		// An explicit return cancels an in-flight native PageUp scroll before its next event.
		align();
		followLatestIfPinned();
	}, [align, followLatestIfPinned]);
	const onHistoryScroll = useCallback(
		(target: HTMLDivElement) => {
			const top = Math.max(0, target.scrollTop);
			const bottom = Math.max(0, target.scrollHeight - target.clientHeight);
			const resized =
				lastSize.current.height !== target.scrollHeight ||
				lastSize.current.viewport !== target.clientHeight;
			// Content shrinking or a taller viewport can clamp the old scroll position.
			const previous = Math.min(lastTop.current, bottom);
			if (top < previous - 1 && !resized) pause();
			else if (top > previous && bottom - top <= 2 && !followLatest.current)
				scrollLatest();
			lastTop.current = top;
			lastSize.current = {
				height: target.scrollHeight,
				viewport: target.clientHeight,
			};
			if (resized) followLatestIfPinned();
		},
		[pause, scrollLatest, followLatestIfPinned],
	);
	useLayoutEffect(() => {
		const history = historyRef.current;
		const content = contentRef.current;
		if (!history || !content) return;
		// Stop a queued follow before the browser applies an upward wheel/key/touch gesture.
		const up = () => {
			if (history.scrollTop > 0) pause();
		};
		const wheel = (event: WheelEvent) => {
			if (event.deltaY < 0) up();
		};
		const key = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				(event.target instanceof Element &&
					event.target.closest("input,textarea,select,[contenteditable=true]"))
			)
				return;
			if (
				["ArrowUp", "PageUp", "Home"].includes(event.key) ||
				(event.key === " " && event.shiftKey && event.target === history)
			)
				up();
		};
		let touchY: number | undefined;
		const touchStart = (event: TouchEvent) => {
			touchY = event.touches[0]?.clientY;
		};
		const touchMove = (event: TouchEvent) => {
			const next = event.touches[0]?.clientY;
			if (next !== undefined && touchY !== undefined && next > touchY) up();
			touchY = next;
		};
		history.addEventListener("wheel", wheel, { passive: true });
		history.addEventListener("keydown", key);
		history.addEventListener("touchstart", touchStart, { passive: true });
		history.addEventListener("touchmove", touchMove, { passive: true });
		const observer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(followLatestIfPinned);
		observer?.observe(history);
		observer?.observe(content);
		followLatestIfPinned();
		return () => {
			observer?.disconnect();
			history.removeEventListener("wheel", wheel);
			history.removeEventListener("keydown", key);
			history.removeEventListener("touchstart", touchStart);
			history.removeEventListener("touchmove", touchMove);
			if (frame.current !== null) cancelAnimationFrame(frame.current);
			frame.current = null;
		};
	}, [followLatestIfPinned, pause]);
	return {
		historyRef,
		contentRef,
		showLatest,
		followLatestIfPinned,
		scrollLatest,
		onHistoryScroll,
	};
}
