import {
	act,
	cleanup,
	fireEvent,
	render,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { LightAvatarBackground } from "./LightAvatarBackground";
import { createLightAvatar } from "./light-avatar/model.js";
import { backgroundAvatar, setMotionLabOnScreen } from "./light-avatar/load";

vi.mock("./light-avatar/model.js", () => ({ createLightAvatar: vi.fn() }));
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
function supportReducedMotion() {
	vi.stubGlobal("requestIdleCallback", (callback: () => void) => {
		setTimeout(callback, 0);
		return 1;
	});
	vi.stubGlobal("cancelIdleCallback", vi.fn());
	vi.stubGlobal("WebGL2RenderingContext", class {});
	vi.stubGlobal("matchMedia", () => ({
		matches: true,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	}));
}

test("initialization failure stays diagnosable without exposing its message", async () => {
	supportReducedMotion();
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.mocked(createLightAvatar).mockImplementation(() => {
		throw new TypeError("private diagnostic text");
	});
	const view = render(<LightAvatarBackground active />);
	await waitFor(() => {
		expect(
			view.container.firstElementChild?.getAttribute("data-avatar-state"),
		).toBe("load-failed");
	});
	expect(warn).toHaveBeenCalledWith("Light avatar initialization failed", {
		kind: "TypeError",
	});
});

test("a failed first static frame releases the model once and preserves its failure state", async () => {
	supportReducedMotion();
	const dispose = vi.fn();
	vi.mocked(createLightAvatar).mockReturnValue({
		canvas: document.createElement("canvas"),
		beginMotion: vi.fn(),
		setLayers: vi.fn(),
		showSkeleton: vi.fn(),
		react: vi.fn(() => 0),
		hitTest: vi.fn(() => null),
		resize: vi.fn(),
		render: () => {
			throw new Error("render failed");
		},
		dispose,
		stats: () => ({ armCount: 0, points: 0, triangles: 0, drawCalls: 0 }),
	});
	const view = render(<LightAvatarBackground active />);
	await waitFor(() => {
		expect(
			view.container.firstElementChild?.getAttribute("data-avatar-state"),
		).toBe("render-failed");
	});
	view.unmount();
	expect(dispose).toHaveBeenCalledTimes(1);
});

test("hiding the tab pauses playback without rebuilding the model", async () => {
	supportReducedMotion();
	const dispose = vi.fn();
	const create = vi.mocked(createLightAvatar);
	create.mockClear();
	create.mockReturnValue({
		canvas: document.createElement("canvas"),
		beginMotion: vi.fn(),
		setLayers: vi.fn(),
		showSkeleton: vi.fn(),
		react: vi.fn(() => 0),
		hitTest: vi.fn(() => null),
		resize: vi.fn(),
		render: vi.fn(),
		dispose,
		stats: () => ({ armCount: 0, points: 0, triangles: 0, drawCalls: 0 }),
	});
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	const view = render(<LightAvatarBackground active />);
	const state = () =>
		view.container.firstElementChild?.getAttribute("data-avatar-state");
	await waitFor(() => expect(state()).toBe("ready"));
	let visibility: DocumentVisibilityState = "hidden";
	vi.spyOn(document, "visibilityState", "get").mockImplementation(
		() => visibility,
	);
	act(() => {
		document.dispatchEvent(new Event("visibilitychange"));
	});
	expect(state()).toBe("paused");
	visibility = "visible";
	act(() => {
		document.dispatchEvent(new Event("visibilitychange"));
	});
	expect(state()).toBe("ready");
	expect(create).toHaveBeenCalledTimes(1);
	expect(dispose).not.toHaveBeenCalled();
	view.unmount();
	expect(dispose).toHaveBeenCalledTimes(1);
});

function lostFixture() {
	supportReducedMotion();
	const create = vi.mocked(createLightAvatar);
	create.mockReset();
	const canvases: HTMLCanvasElement[] = [];
	create.mockImplementation(() => {
		const canvas = document.createElement("canvas");
		canvases.push(canvas);
		return {
			canvas,
			beginMotion: vi.fn(),
			setLayers: vi.fn(),
			showSkeleton: vi.fn(),
			react: vi.fn(() => 0),
			hitTest: vi.fn(() => null),
			resize: vi.fn(),
			render: vi.fn(),
			dispose: vi.fn(),
			stats: () => ({ armCount: 0, points: 0, triangles: 0, drawCalls: 0 }),
		};
	});
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	return { create, canvases };
}
const lose = (canvas: HTMLCanvasElement) =>
	act(() => {
		canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
	});
const advance = (ms: number) =>
	act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});

test("a lost WebGL context is rebuilt after a delay", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		const { create, canvases } = lostFixture();
		const view = render(<LightAvatarBackground active />);
		const state = () =>
			view.container.firstElementChild?.getAttribute("data-avatar-state");
		await advance(10);
		expect(state()).toBe("ready");
		lose(canvases[0]!);
		expect(state()).toBe("context-lost");
		await advance(2000);
		expect(create).toHaveBeenCalledTimes(2);
		expect(state()).toBe("ready");
	} finally {
		vi.useRealTimers();
	}
});

test("rebuilding stops after three restarts", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		const { create, canvases } = lostFixture();
		const view = render(<LightAvatarBackground active />);
		await advance(10);
		for (let i = 0; i < 4; i += 1) {
			lose(canvases[i]!);
			await advance(20_000);
		}
		expect(create).toHaveBeenCalledTimes(4);
		expect(
			view.container.firstElementChild?.getAttribute("data-avatar-state"),
		).toBe("context-lost");
	} finally {
		vi.useRealTimers();
	}
});

test("unmounting while a rebuild is pending cancels it", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		const { create, canvases } = lostFixture();
		const view = render(<LightAvatarBackground active />);
		await advance(10);
		lose(canvases[0]!);
		view.unmount();
		await advance(10_000);
		expect(create).toHaveBeenCalledTimes(1);
	} finally {
		vi.useRealTimers();
	}
});

test("the background lends its model to the settings motion lab while it is on screen", async () => {
	const { create } = lostFixture();
	const view = render(<LightAvatarBackground active />);
	const state = () =>
		view.container.firstElementChild?.getAttribute("data-avatar-state");
	await waitFor(() => expect(state()).toBe("ready"));
	expect(backgroundAvatar()).toBe(create.mock.results[0]!.value);
	act(() => setMotionLabOnScreen(true));
	expect(state()).toBe("motion-lab");
	act(() => setMotionLabOnScreen(false));
	expect(state()).toBe("ready");
	// Handing over keeps the model: no second renderer is built.
	expect(create).toHaveBeenCalledTimes(1);
	view.unmount();
	expect(backgroundAvatar()).toBeNull();
});

test("only background mode takes touches: a hit shows a gold ring and reduced motion never moves the spirit", async () => {
	const { create } = lostFixture();
	const view = render(<LightAvatarBackground active />);
	const host = () => view.container.firstElementChild as HTMLElement;
	await waitFor(() =>
		expect(host().getAttribute("data-avatar-state")).toBe("ready"),
	);
	const model = create.mock.results[0]!.value;
	vi.mocked(model.hitTest).mockReturnValue("head");
	fireEvent.click(host());
	expect(model.hitTest).not.toHaveBeenCalled();
	expect(view.container.querySelector(".light-avatar-touch")).toBeNull();
	view.rerender(<LightAvatarBackground active interactive />);
	expect(host().hasAttribute("data-interactive")).toBe(true);
	fireEvent.click(host(), { clientX: 30, clientY: 40 });
	expect(model.hitTest).toHaveBeenLastCalledWith(30, 40);
	expect(
		view.container.querySelector(".light-avatar-touch[data-hit]"),
	).toBeTruthy();
	expect(model.react).not.toHaveBeenCalled();
	vi.mocked(model.hitTest).mockReturnValue(null);
	fireEvent.click(host());
	expect(view.container.querySelectorAll(".light-avatar-touch")).toHaveLength(
		2,
	);
	view.rerender(<LightAvatarBackground active interactive={false} />);
	expect(host().hasAttribute("data-interactive")).toBe(false);
	expect(view.container.querySelector(".light-avatar-touch")).toBeNull();
});

test("touching the spirit in background mode plays the reaction for the touched part", async () => {
	const { create } = lostFixture();
	vi.stubGlobal("matchMedia", () => ({
		matches: false,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	}));
	const view = render(<LightAvatarBackground active interactive />);
	const host = () => view.container.firstElementChild as HTMLElement;
	await waitFor(() =>
		expect(host().getAttribute("data-avatar-state")).toBe("ready"),
	);
	const model = create.mock.results[0]!.value;
	vi.mocked(model.react).mockReturnValue(2.4);
	vi.mocked(model.hitTest).mockReturnValue("body");
	fireEvent.click(host());
	expect(model.react).toHaveBeenCalledWith("touched-body");
});
