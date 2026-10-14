import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Canvas2D } from "./Canvas2D";

const context = {
	setTransform: vi.fn(),
	clearRect: vi.fn(),
	save: vi.fn(),
	restore: vi.fn(),
	beginPath: vi.fn(),
	rect: vi.fn(),
	clip: vi.fn(),
};
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let resize: (() => void) | undefined;

beforeEach(() => {
	frames = new Map();
	nextFrame = 0;
	resize = undefined;
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
		context as unknown as CanvasRenderingContext2D,
	);
	vi.spyOn(
		HTMLCanvasElement.prototype,
		"getBoundingClientRect",
	).mockReturnValue({
		left: 10,
		top: 20,
		width: 240,
		height: 120,
	} as DOMRect);
	vi.stubGlobal("devicePixelRatio", 2);
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
	Object.values(context).forEach((mock) => {
		mock.mockClear();
	});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function advance(time: number) {
	const pending = [...frames.values()];
	frames.clear();
	act(() =>
		pending.forEach((callback) => {
			callback(time);
		}),
	);
}

it("scales and clips an arbitrary world viewport, then redraws on camera change and resize", () => {
	const draw = vi.fn();
	const { rerender, getByRole } = render(
		<Canvas2D
			ariaLabel="scene"
			viewport={{ x: 10, y: 20, width: 12, height: 6 }}
			draw={draw}
		/>,
	);
	advance(100);
	const canvas = getByRole("img", { name: "scene" }) as HTMLCanvasElement;
	expect(canvas.width).toBe(480);
	expect(canvas.height).toBe(240);
	expect(context.setTransform).toHaveBeenLastCalledWith(
		40,
		0,
		0,
		40,
		-400,
		-800,
	);
	expect(context.rect).toHaveBeenCalledWith(0, 0, 480, 240);
	expect(draw).toHaveBeenCalledWith(context, {
		viewport: { x: 10, y: 20, width: 12, height: 6 },
		elapsedMs: 0,
		deltaMs: 0,
	});
	rerender(
		<Canvas2D
			ariaLabel="scene"
			viewport={{ x: 22, y: 20, width: 12, height: 6 }}
			draw={draw}
		/>,
	);
	advance(120);
	expect(context.setTransform).toHaveBeenLastCalledWith(
		40,
		0,
		0,
		40,
		-880,
		-800,
	);
	act(() => resize?.());
	advance(140);
	expect(draw).toHaveBeenCalledTimes(3);
});

it("runs continuous frames and stops them while hidden or unmounted", () => {
	const draw = vi.fn();
	const { unmount } = render(
		<Canvas2D
			ariaLabel="scene"
			viewport={{ x: 0, y: 0, width: 2, height: 1 }}
			draw={draw}
			playing
		/>,
	);
	advance(100);
	advance(116);
	expect(draw.mock.calls[1]?.[1]).toMatchObject({ elapsedMs: 16, deltaMs: 16 });
	Object.defineProperty(document, "hidden", {
		configurable: true,
		value: true,
	});
	act(() => document.dispatchEvent(new Event("visibilitychange")));
	expect(frames.size).toBe(0);
	Object.defineProperty(document, "hidden", {
		configurable: true,
		value: false,
	});
	act(() => document.dispatchEvent(new Event("visibilitychange")));
	advance(1000);
	expect(draw.mock.calls[2]?.[1]).toMatchObject({ elapsedMs: 16, deltaMs: 0 });
	unmount();
	expect(frames.size).toBe(0);
	delete (document as { hidden?: boolean }).hidden;
});

it("waits for a visible size before resuming animation", () => {
	const draw = vi.fn();
	const { unmount } = render(
		<Canvas2D
			ariaLabel="scene"
			viewport={{ x: 0, y: 0, width: 2, height: 1 }}
			draw={draw}
			playing
		/>,
	);
	vi.spyOn(
		HTMLCanvasElement.prototype,
		"getBoundingClientRect",
	).mockReturnValue({
		left: 0,
		top: 0,
		width: 0,
		height: 0,
	} as DOMRect);
	advance(100);
	expect(draw).not.toHaveBeenCalled();
	expect(frames.size).toBe(0);
	vi.spyOn(
		HTMLCanvasElement.prototype,
		"getBoundingClientRect",
	).mockReturnValue({
		left: 0,
		top: 0,
		width: 200,
		height: 100,
	} as DOMRect);
	act(() => resize?.());
	advance(120);
	expect(draw).toHaveBeenCalledOnce();
	expect(frames.size).toBe(1);
	unmount();
});

it("maps pointer input into world coordinates and forwards keyboard input", () => {
	const onPointer = vi.fn();
	const onKeyDown = vi.fn();
	const { getByRole } = render(
		<Canvas2D
			ariaLabel="scene"
			viewport={{ x: 5, y: 7, width: 12, height: 6 }}
			draw={() => {}}
			onPointer={onPointer}
			onKeyDown={onKeyDown}
		/>,
	);
	const canvas = getByRole("application", { name: "scene" });
	fireEvent.pointerDown(canvas, {
		clientX: 130,
		clientY: 80,
		pointerId: 3,
		buttons: 1,
	});
	expect(canvas).toHaveFocus();
	fireEvent.pointerMove(canvas, {
		clientX: 130,
		clientY: 80,
		pointerId: 3,
		buttons: 1,
	});
	expect(onPointer).toHaveBeenCalledWith({
		type: "move",
		x: 11,
		y: 10,
		inside: true,
		buttons: 1,
		pointerId: 3,
	});
	fireEvent.keyDown(canvas, { key: "ArrowLeft" });
	expect(onKeyDown).toHaveBeenCalledOnce();
	expect(canvas).toHaveAttribute("tabindex", "0");
});

it("preserves aspect ratio when the displayed rectangle differs and marks margin input outside", () => {
	const draw = vi.fn();
	const onPointer = vi.fn();
	const { getByRole } = render(
		<Canvas2D
			ariaLabel="wide scene"
			viewport={{ x: 100, y: 50, width: 10, height: 10 }}
			draw={draw}
			onPointer={onPointer}
		/>,
	);
	advance(100);
	expect(context.rect).toHaveBeenCalledWith(120, 0, 240, 240);
	const canvas = getByRole("application", { name: "wide scene" });
	fireEvent.pointerMove(canvas, {
		clientX: 10,
		clientY: 80,
		pointerId: 4,
		buttons: 0,
	});
	expect(onPointer).toHaveBeenCalledWith({
		type: "move",
		x: 95,
		y: 55,
		inside: false,
		buttons: 0,
		pointerId: 4,
	});
});
