import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { LightAvatarBackground } from "./LightAvatarBackground";
import { createLightAvatar } from "./light-avatar/model.js";

vi.mock("./light-avatar/model.js", () => ({ createLightAvatar: vi.fn() }));
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
function supportReducedMotion() {
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
