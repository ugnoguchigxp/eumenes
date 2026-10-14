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
import { motionLabOnScreen, setBackgroundAvatar } from "./light-avatar/load";

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
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.push(callback);
		return frames.length;
	});
	vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
	cleanup();
	setBackgroundAvatar(null);
	vi.unstubAllGlobals();
	vi.mocked(createLightAvatar).mockReset();
});
const step = (at: number) => {
	const pending = frames;
	frames = [];
	for (const callback of pending) callback(at);
};

test("on screen, the lab drives the background's spirit and hands it back when hidden", async () => {
	const avatar = model();
	setBackgroundAvatar(avatar);
	render(<LightAvatarMotionLab />);
	expect(motionLabOnScreen()).toBe(false);
	act(() => intersect(true));
	await waitFor(() =>
		expect(
			(screen.getByRole("button", { name: "うれしい" }) as HTMLButtonElement)
				.disabled,
		).toBe(false),
	);
	expect(motionLabOnScreen()).toBe(true);
	expect(screen.getByText("会話の背景の精霊で再生しています。")).toBeTruthy();
	expect(screen.getByRole("group", { name: "待機中の仕草" })).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "うれしい" }));
	expect(avatar.beginMotion).toHaveBeenLastCalledWith(undefined);
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
	expect(motionLabOnScreen()).toBe(false);
	expect(avatar.showSkeleton).toHaveBeenLastCalledWith(false);
	expect(avatar.setLayers).toHaveBeenLastCalledWith({
		secondary: true,
		gaze: true,
		gestures: true,
	});
	// The lab never builds a renderer of its own.
	expect(createLightAvatar).not.toHaveBeenCalled();
});

test("without the background spirit the lab explains how to get one", async () => {
	render(<LightAvatarMotionLab />);
	act(() => intersect(true));
	await waitFor(() =>
		expect(screen.getByText("動かせる精霊がありません")).toBeTruthy(),
	);
	expect(motionLabOnScreen()).toBe(false);
	expect(
		(screen.getByRole("button", { name: "うれしい" }) as HTMLButtonElement)
			.disabled,
	).toBe(true);
});
