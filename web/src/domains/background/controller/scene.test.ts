import { Group } from "three";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createSpatialScene } from "./scene";
import type { SpatialItem, SpatialModel } from "../contracts";

const gpu = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("three", async (original) => ({
	...(await original<typeof import("three")>()),
	WebGLRenderer: vi.fn(function () {
		return gpu.create();
	}),
}));
let frames: Map<number, FrameRequestCallback>;
let preference: {
	matches: boolean;
	addEventListener: ReturnType<typeof vi.fn>;
	removeEventListener: ReturnType<typeof vi.fn>;
};
let mediaChanged: () => void;
let resize: () => void;
let hidden: boolean;
let renderer: {
	domElement: HTMLCanvasElement;
	render: ReturnType<typeof vi.fn>;
	setSize: ReturnType<typeof vi.fn>;
	setPixelRatio: ReturnType<typeof vi.fn>;
	setClearColor: ReturnType<typeof vi.fn>;
	dispose: ReturnType<typeof vi.fn>;
	forceContextLoss: ReturnType<typeof vi.fn>;
};
const live: ReturnType<typeof createSpatialScene>[] = [];
beforeEach(() => {
	frames = new Map();
	hidden = false;
	let id = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++id, callback);
		return id;
	});
	vi.stubGlobal("cancelAnimationFrame", (frame: number) =>
		frames.delete(frame),
	);
	vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
	preference = {
		matches: false,
		addEventListener: vi.fn((_event, listener) => {
			mediaChanged = listener;
		}),
		removeEventListener: vi.fn(),
	};
	vi.stubGlobal("matchMedia", () => preference);
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
	renderer = {
		domElement: document.createElement("canvas"),
		render: vi.fn(),
		setSize: vi.fn(),
		setPixelRatio: vi.fn(),
		setClearColor: vi.fn(),
		dispose: vi.fn(),
		forceContextLoss: vi.fn(),
	};
	gpu.create.mockReturnValue(renderer);
});
afterEach(() => {
	for (const scene of live.splice(0)) scene.dispose();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});
function item(id = "cpu"): SpatialItem {
	return {
		id,
		label: id,
		model: "test",
		position: [0, 0, 0],
		state: { health: "healthy", activity: "working", stale: false },
	};
}
function setup() {
	const host = document.createElement("div");
	vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
		width: 800,
		height: 600,
	} as DOMRect);
	const model: SpatialModel = {
		object: new Group(),
		update: vi.fn(),
		animate: vi.fn(),
		dispose: vi.fn(),
	};
	const factory = vi.fn(() => model);
	const status = vi.fn();
	const scene = createSpatialScene(host, [item()], {
		models: { test: factory },
		onStatus: status,
	});
	live.push(scene);
	return { host, model, factory, scene, status };
}
test("one context is reused for health/selection changes and released on removal", () => {
	const { host, model, factory, scene } = setup();
	expect(host.querySelectorAll("canvas")).toHaveLength(1);
	const next = item();
	next.state.health = "pressure";
	scene.setItems([next]);
	scene.select("cpu");
	expect(factory).toHaveBeenCalledOnce();
	expect(gpu.create).toHaveBeenCalledOnce();
	expect(model.update).toHaveBeenLastCalledWith(next.state, true);
	scene.setItems([]);
	expect(model.dispose).toHaveBeenCalledOnce();
	scene.dispose();
	scene.dispose();
	expect(host.querySelectorAll("canvas")).toHaveLength(0);
	expect(model.dispose).toHaveBeenCalledOnce();
	expect(renderer.dispose).toHaveBeenCalledOnce();
	expect(renderer.forceContextLoss).toHaveBeenCalledOnce();
});
test("hidden tabs stop frames, stale callbacks cannot animate, and motion preference redraws statically", () => {
	const { model, status } = setup();
	const delayed = [...frames.values()][0]!;
	hidden = true;
	document.dispatchEvent(new Event("visibilitychange"));
	expect(frames.size).toBe(0);
	delayed(1000);
	expect(model.animate).not.toHaveBeenCalled();
	expect(status).toHaveBeenLastCalledWith("paused");
	hidden = false;
	document.dispatchEvent(new Event("visibilitychange"));
	expect(frames.size).toBe(1);
	preference.matches = true;
	mediaChanged();
	expect(frames.size).toBe(0);
	expect(status).toHaveBeenLastCalledWith("ready");
});
test("idle and unconfirmed objects do not run an animation loop", () => {
	const { scene } = setup();
	const next = item();
	next.state.health = "unknown";
	scene.setItems([next]);
	expect(frames.size).toBe(0);
	next.state.health = "healthy";
	next.state.stale = true;
	scene.setItems([next]);
	expect(frames.size).toBe(0);
});
test("resize updates the viewport without replacing models or creating a second context", () => {
	const { factory } = setup();
	resize();
	expect(renderer.setSize).toHaveBeenLastCalledWith(800, 600, false);
	expect(factory).toHaveBeenCalledOnce();
	expect(gpu.create).toHaveBeenCalledOnce();
});
test("context loss stops rendering and releases every resource once", () => {
	const { host, model, status, scene } = setup();
	renderer.domElement.dispatchEvent(
		new Event("webglcontextlost", { cancelable: true }),
	);
	expect(status).toHaveBeenLastCalledWith("failed");
	expect(host.querySelectorAll("canvas")).toHaveLength(0);
	expect(frames.size).toBe(0);
	scene.setItems([item()]);
	scene.dispose();
	expect(model.dispose).toHaveBeenCalledOnce();
	expect(renderer.dispose).toHaveBeenCalledOnce();
});
test("a model update failure releases the model and leaves the scene failed", () => {
	const { scene, model, status } = setup();
	vi.mocked(model.update).mockImplementation(() => {
		throw new Error("model failed");
	});
	scene.setItems([item()]);
	expect(model.dispose).toHaveBeenCalledOnce();
	expect(status).toHaveBeenLastCalledWith("failed");
	expect(frames.size).toBe(0);
});
test("pick finds the object under the pointer within a finger-sized circle and nothing elsewhere", () => {
	const host = document.createElement("div");
	vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
		left: 100,
		top: 50,
		width: 800,
		height: 600,
	} as DOMRect);
	const model: SpatialModel = {
		object: new Group(),
		update: vi.fn(),
		bounds: () => ({ radius: 0, depth: 0 }),
		dispose: vi.fn(),
	};
	const scene = createSpatialScene(host, [item()], {
		models: { test: () => model },
		onStatus: vi.fn(),
	});
	live.push(scene);
	// The overview centres the origin in the host.
	expect(scene.pick(500, 350)).toBe("cpu");
	expect(scene.pick(520, 350)).toBe("cpu");
	expect(scene.pick(530, 350)).toBeNull();
	expect(scene.pick(110, 60)).toBeNull();
	scene.dispose();
	expect(scene.pick(500, 350)).toBeNull();
});
