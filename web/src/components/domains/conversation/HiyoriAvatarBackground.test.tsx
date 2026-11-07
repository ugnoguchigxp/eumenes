import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { HiyoriAvatarBackground } from "./HiyoriAvatarBackground";
import { createHiyori, defaultAvatarView } from "../../../domains/avatar";
import { readAssistantMouth } from "../../../domains/audio";

vi.mock("../../../domains/avatar", async (original) => ({
	...(await original<typeof import("../../../domains/avatar")>()),
	createHiyori: vi.fn(),
}));
vi.mock("../../../domains/audio", () => ({ readAssistantMouth: vi.fn() }));

beforeEach(() => localStorage.clear());

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function fixture(reduced = false) {
	vi.clearAllMocks();
	let draw: FrameRequestCallback | undefined;
	let time = performance.now();
	vi.stubGlobal(
		"requestAnimationFrame",
		vi.fn((next: FrameRequestCallback) => {
			draw = next;
			return 1;
		}),
	);
	vi.stubGlobal("cancelAnimationFrame", vi.fn());
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal("matchMedia", () => ({
		matches: reduced,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	}));
	const model = {
		canvas: document.createElement("canvas"),
		resize: vi.fn(),
		dispose: vi.fn(),
		render: vi.fn(),
		stats: () => ({ mouthOpen: 0, eyeOpen: 1, textures: 2 }),
	};
	vi.mocked(createHiyori).mockResolvedValue(model);
	vi.mocked(readAssistantMouth).mockReturnValue(0.45);
	const view = render(<HiyoriAvatarBackground active phase="thinking" />);
	await waitFor(() => expect(model.render).toHaveBeenCalled());
	return {
		view,
		model,
		step: () => act(() => draw?.((time += 1000))),
	};
}

test("phase and replay cues reach the same mounted model with speech amplitude", async () => {
	const { view, model, step } = await fixture();
	expect(model.render).toHaveBeenLastCalledWith(
		expect.any(Number),
		"thinking",
		0.45,
		undefined,
		defaultAvatarView,
	);
	view.rerender(
		<HiyoriAvatarBackground
			active
			phase="listening"
			cue={{
				key: "speech:1",
				motion: "joyful",
				speaking: true,
				intensity: 0.6,
			}}
		/>,
	);
	step();
	expect(model.render).toHaveBeenLastCalledWith(
		expect.any(Number),
		"joyful",
		0.45,
		0.6,
		defaultAvatarView,
	);
	vi.mocked(readAssistantMouth).mockReturnValue(0);
	view.rerender(<HiyoriAvatarBackground active phase="listening" />);
	step();
	expect(model.render).toHaveBeenLastCalledWith(
		expect.any(Number),
		"listening",
		0,
		undefined,
		defaultAvatarView,
	);
	expect(createHiyori).toHaveBeenCalledTimes(1);
	view.unmount();
	expect(model.dispose).toHaveBeenCalledOnce();
});

test("reduced motion renders a still neutral reference without speech analysis", async () => {
	const { model } = await fixture(true);
	expect(model.render).toHaveBeenLastCalledWith(
		0,
		"neutral",
		0,
		undefined,
		defaultAvatarView,
	);
	expect(readAssistantMouth).not.toHaveBeenCalled();
});

test("view controls only appear in background mode, preserve framing across chat toggles and reset without remounting", async () => {
	const { view, model, step } = await fixture();
	expect(screen.queryByText("モデルの表示調整")).toBeNull();
	view.rerender(<HiyoriAvatarBackground active interactive />);
	fireEvent.click(screen.getByText("モデルの表示調整"));
	fireEvent.change(screen.getByRole("slider", { name: "ズーム" }), {
		target: { value: "235" },
	});
	fireEvent.change(screen.getByRole("slider", { name: "左右の位置" }), {
		target: { value: "12" },
	});
	fireEvent.change(screen.getByRole("slider", { name: "上下の位置" }), {
		target: { value: "-8" },
	});
	expect(model.render.mock.lastCall?.[4]).toEqual({
		zoom: 2.35,
		x: 0.12,
		y: -0.08,
	});
	view.rerender(<HiyoriAvatarBackground active />);
	step();
	expect(screen.queryByText("モデルの表示調整")).toBeNull();
	expect(model.render.mock.lastCall?.[4]).toEqual({
		zoom: 2.35,
		x: 0.12,
		y: -0.08,
	});
	view.rerender(<HiyoriAvatarBackground active interactive />);
	expect(
		(
			screen.getByRole("slider", {
				name: "ズーム",
				hidden: true,
			}) as HTMLInputElement
		).value,
	).toBe("235");
	fireEvent.click(screen.getByText("モデルの表示調整"));
	fireEvent.click(screen.getByRole("button", { name: "上半身" }));
	expect(model.render.mock.lastCall?.[4]).toEqual({ zoom: 2.2, x: 0, y: 0 });
	fireEvent.click(screen.getByRole("button", { name: "リセット" }));
	expect(model.render.mock.lastCall?.[4]).toEqual(defaultAvatarView);
	expect(createHiyori).toHaveBeenCalledTimes(1);
	expect(model.dispose).not.toHaveBeenCalled();
});

test("manual framing redraws once in reduced motion without starting animation or reloading", async () => {
	const { view, model } = await fixture(true);
	view.rerender(<HiyoriAvatarBackground active interactive />);
	fireEvent.click(screen.getByText("モデルの表示調整"));
	const before = model.render.mock.calls.length;
	fireEvent.click(screen.getByRole("button", { name: "上半身" }));
	expect(model.render).toHaveBeenCalledTimes(before + 1);
	expect(model.render).toHaveBeenLastCalledWith(0, "neutral", 0, undefined, {
		zoom: 2.2,
		x: 0,
		y: 0,
	});
	expect(requestAnimationFrame).not.toHaveBeenCalled();
	expect(createHiyori).toHaveBeenCalledTimes(1);
});

test("framing and reset survive destroying and recreating the background", async () => {
	const first = await fixture();
	first.view.rerender(<HiyoriAvatarBackground active interactive />);
	fireEvent.click(screen.getByText("モデルの表示調整"));
	for (const [name, value] of [
		["ズーム", "245"],
		["左右の位置", "-17"],
		["上下の位置", "9"],
	]) {
		fireEvent.change(screen.getByRole("slider", { name }), {
			target: { value },
		});
	}
	first.view.unmount();
	const second = await fixture();
	expect(second.model.render.mock.calls[0]?.[4]).toEqual({
		zoom: 2.45,
		x: -0.17,
		y: 0.09,
	});
	second.view.rerender(<HiyoriAvatarBackground active interactive />);
	fireEvent.click(screen.getByText("モデルの表示調整"));
	fireEvent.click(screen.getByRole("button", { name: "リセット" }));
	second.view.unmount();
	const third = await fixture();
	expect(third.model.render.mock.calls[0]?.[4]).toEqual(defaultAvatarView);
});
