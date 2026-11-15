import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useConversationScroll } from "./useConversationScroll";
import { useLayoutEffect } from "react";

let resize: () => void;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
beforeEach(() => {
	frames = new Map();
	nextFrame = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++nextFrame, callback);
		return nextFrame;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: () => void) {
				resize = callback;
			}
			observe() {}
			disconnect() {}
		},
	);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
const flush = () =>
	act(() => {
		const pending = [...frames.values()];
		frames.clear();
		pending.forEach((callback) => callback(0));
	});

function setup() {
	let scroll!: ReturnType<typeof useConversationScroll>;
	function Fixture() {
		const state = useConversationScroll();
		const { historyRef, contentRef, onHistoryScroll } = state;
		useLayoutEffect(() => {
			scroll = state;
		});
		return (
			<div
				ref={historyRef}
				onScroll={(event) => onHistoryScroll(event.currentTarget)}
			>
				<div ref={contentRef} />
			</div>
		);
	}
	const view = render(<Fixture />);
	const root = scroll.historyRef.current!;
	let height = 1000;
	let viewport = 300;
	let top = 0;
	const writes = vi.fn((value: number) => {
		top = value;
	});
	Object.defineProperties(root, {
		scrollHeight: { configurable: true, get: () => height },
		clientHeight: { configurable: true, get: () => viewport },
		scrollTop: { configurable: true, get: () => top, set: writes },
	});
	flush();
	writes.mockClear();
	return {
		root,
		view,
		writes,
		scroll: () => scroll,
		height: (value: number) => {
			height = value;
		},
		viewport: (value: number) => {
			viewport = value;
		},
		move: (value: number) => {
			top = value;
			fireEvent.scroll(root);
		},
	};
}

test("coalesces stream and size updates into one scroll write and skips unchanged geometry", () => {
	const h = setup();
	h.height(1200);
	for (let i = 0; i < 10; i++) {
		h.scroll().followLatestIfPinned();
		resize();
	}
	expect(frames.size).toBe(1);
	flush();
	expect(h.root.scrollTop).toBe(900);
	expect(h.writes).toHaveBeenCalledTimes(1);
	resize();
	flush();
	expect(h.writes).toHaveBeenCalledTimes(1);
	h.view.unmount();
	expect(frames.size).toBe(0);
});

test("an upward gesture cancels a queued follow and only returning down resumes it", () => {
	const h = setup();
	h.height(1200);
	resize();
	fireEvent.wheel(h.root, { deltaY: -10 });
	h.move(690);
	flush();
	expect(h.root.scrollTop).toBe(690);
	expect(h.scroll().showLatest).toBe(true);
	h.height(1400);
	resize();
	flush();
	expect(h.writes).not.toHaveBeenCalled();
	h.move(1100);
	expect(h.scroll().showLatest).toBe(false);
	h.height(1500);
	resize();
	flush();
	expect(h.root.scrollTop).toBe(1200);
});

test("content shrink and viewport expansion keep following instead of looking like user scrolling", () => {
	const h = setup();
	h.height(600);
	h.move(300);
	expect(h.scroll().showLatest).toBe(false);
	h.viewport(500);
	h.move(100);
	expect(h.scroll().showLatest).toBe(false);
	h.height(1000);
	resize();
	flush();
	expect(h.root.scrollTop).toBe(500);
});

test("an explicit return reaches latest immediately, before another native scroll event can pause it", () => {
	const h = setup();
	fireEvent.keyDown(h.root, { key: "PageUp" });
	h.move(350);
	act(() => h.scroll().scrollLatest());
	expect(h.root.scrollTop).toBe(700);
	expect(h.scroll().showLatest).toBe(false);
	flush();
	expect(h.writes).toHaveBeenCalledTimes(1);
});

test("a collapsed history followed by new content does not mistake the delayed scroll event for an upward gesture", () => {
	const h = setup();
	h.height(600);
	h.root.scrollTop = 300;
	h.height(820);
	resize();
	h.move(300);
	flush();
	expect(h.scroll().showLatest).toBe(false);
	expect(h.root.scrollTop).toBe(520);
});
