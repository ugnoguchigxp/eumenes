import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LightAvatarMotionLab } from "./LightAvatarMotionLab";
import { createLightAvatar } from "./light-avatar/model.js";

vi.mock("./light-avatar/model.js", () => ({
	createLightAvatar: vi.fn(),
	motionGroups: { emotion: "感情と仕草", "idle-gesture": "待機中の仕草" },
	motions: [
		{
			id: "joyful",
			label: "うれしい",
			group: "emotion",
			duration: 8,
			variants: [
				{ id: "joyful-spin", label: "跳ねて1回転" },
				{ id: "joyful-bounce", label: "弾む" },
			],
		},
		{
			id: "twirl",
			label: "くるっと回る",
			group: "idle-gesture",
			duration: 3.5,
			variants: [{ id: "twirl", label: "1回転" }],
		},
	],
}));

let intersect: (visible: boolean) => void = () => {};
let frames: FrameRequestCallback[] = [];
const model = () => ({
	canvas: document.createElement("canvas"),
	resize: vi.fn(),
	render: vi.fn(),
	beginMotion: vi.fn(),
	setLayers: vi.fn(),
	showSkeleton: vi.fn(),
	dispose: vi.fn(),
	stats: () => ({ variantLabel: "跳ねて1回転" }),
});
beforeEach(() => {
	frames = [];
	vi.stubGlobal("WebGL2RenderingContext", class {});
	vi.stubGlobal("matchMedia", () => ({ matches: false }));
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			constructor(callback: IntersectionObserverCallback) {
				intersect = (visible) =>
					callback(
						[{ isIntersecting: visible } as IntersectionObserverEntry],
						this as unknown as IntersectionObserver,
					);
			}
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.push(callback);
		return frames.length;
	});
	vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.mocked(createLightAvatar).mockReset();
});
const step = (at: number) => {
	const pending = frames;
	frames = [];
	for (const callback of pending) callback(at);
};

test("the renderer loads only on screen, plays a chosen motion, and is released off screen", async () => {
	const avatar = model();
	vi.mocked(createLightAvatar).mockReturnValue(avatar);
	render(<LightAvatarMotionLab />);
	expect(createLightAvatar).not.toHaveBeenCalled();
	act(() => intersect(true));
	await waitFor(() =>
		expect(
			(screen.getByRole("button", { name: "うれしい" }) as HTMLButtonElement)
				.disabled,
		).toBe(false),
	);
	expect(screen.getByRole("group", { name: "待機中の仕草" })).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "うれしい" }));
	expect(avatar.beginMotion).toHaveBeenCalledWith(undefined);
	fireEvent.change(screen.getByLabelText("変化版"), {
		target: { value: "joyful-bounce" },
	});
	expect(avatar.beginMotion).toHaveBeenLastCalledWith({
		variant: "joyful-bounce",
	});
	act(() => {
		step(performance.now() + 100);
		step(performance.now() + 200);
	});
	expect(avatar.render).toHaveBeenCalledWith(
		expect.any(Number),
		"joyful",
		expect.any(Number),
		false,
	);
	fireEvent.click(screen.getByRole("switch", { name: "ボーンを表示する" }));
	expect(avatar.showSkeleton).toHaveBeenLastCalledWith(true);
	fireEvent.click(screen.getByRole("switch", { name: "視線" }));
	expect(avatar.setLayers).toHaveBeenLastCalledWith(
		expect.objectContaining({ gaze: false }),
	);
	act(() => intersect(false));
	expect(avatar.dispose).toHaveBeenCalled();
});

test("without WebGL 2 the lab says so and never loads the renderer", () => {
	vi.stubGlobal("WebGL2RenderingContext", undefined);
	render(<LightAvatarMotionLab />);
	act(() => intersect(true));
	expect(screen.getByText("この環境では3D表示を利用できません")).toBeTruthy();
	expect(createLightAvatar).not.toHaveBeenCalled();
});
