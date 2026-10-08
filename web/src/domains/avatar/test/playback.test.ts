import { expect, test, vi } from "vitest";
import { createAvatarPlayback } from "..";

function playback(reduced = false) {
	const model = { render: vi.fn(), beginMotion: vi.fn() };
	const frames = new Map<number, FrameRequestCallback>();
	let next = 0,
		clock = 0;
	const controller = createAvatarPlayback(model, {
		reduced,
		now: () => clock,
		requestFrame: (fn) => {
			frames.set(++next, fn);
			return next;
		},
		cancelFrame: (id) => frames.delete(id),
	});
	const step = (ms: number) => {
		clock = ms;
		const entry = frames.entries().next().value!;
		frames.delete(entry[0]);
		entry[1](ms);
	};
	return { model, frames, controller, step };
}

test("idle breathes continuously at a capped rate without an initial cue", () => {
	const h = playback();
	h.controller.setCue(null);
	h.step(0);
	h.step(40);
	expect(h.model.render).toHaveBeenCalledTimes(1);
	h.step(84);
	expect(h.model.render).toHaveBeenCalledTimes(2);
	h.step(120000);
	expect(h.model.render).toHaveBeenLastCalledWith(120, "neutral", 120);
	expect(h.frames.size).toBe(1);
	expect(h.model.beginMotion).not.toHaveBeenCalled();
	h.controller.dispose();
	expect(h.frames.size).toBe(0);
});

test("a cue plays once then returns to moving idle with a continuous global clock", () => {
	const h = playback();
	const cue = { key: "generation:utterance:0", motion: "greeting" as const };
	h.controller.setCue(cue);
	h.controller.setCue(cue);
	expect(h.model.beginMotion).toHaveBeenCalledTimes(1);
	h.step(1000);
	expect(h.model.render).toHaveBeenLastCalledWith(1, "greeting", 1);
	h.step(8700);
	const recovered = h.model.render.mock.calls.at(-1)!;
	expect(recovered[0]).toBe(8.7);
	expect(recovered[1]).toBe("neutral");
	expect(recovered[2]).toBeCloseTo(0.7);
	h.step(10000);
	expect(h.model.render).toHaveBeenLastCalledWith(10, "neutral", 2);
	h.controller.setCue({ key: "second", motion: "joyful" });
	h.step(11000);
	expect(h.model.render).toHaveBeenLastCalledWith(11, "joyful", 1);
	h.controller.dispose();
});

test("cancellation recovers to idle, fences old frames, and disposal stops every update", () => {
	const h = playback();
	h.controller.setCue({ key: "one", motion: "joyful" });
	h.step(1000);
	const stale = h.frames.values().next().value!;
	h.controller.setCue(null);
	expect(h.model.render).toHaveBeenLastCalledWith(1, "neutral", 0);
	const count = h.model.render.mock.calls.length;
	stale(9000);
	expect(h.model.render).toHaveBeenCalledTimes(count);
	expect(h.frames.size).toBe(1);
	h.step(2000);
	expect(h.model.render).toHaveBeenLastCalledWith(2, "neutral", 1);
	const pending = h.frames.values().next().value!;
	h.controller.dispose();
	const disposedCount = h.model.render.mock.calls.length;
	pending(3000);
	h.controller.redraw();
	h.controller.setCue({ key: "late", motion: "greeting" });
	expect(h.model.render).toHaveBeenCalledTimes(disposedCount);
	expect(h.frames.size).toBe(0);
});

test("reduced motion keeps a still neutral pose without scheduling frames", () => {
	const h = playback(true);
	h.controller.setCue({ key: "one", motion: "greeting", speaking: true });
	h.controller.setCue(null);
	expect(h.frames.size).toBe(0);
	expect(h.model.render).toHaveBeenLastCalledWith(0, "neutral", 1);
	h.controller.dispose();
});

test("speech and its Laya motion persist past eight seconds and stop with the actual audio cue", () => {
	const h = playback();
	h.controller.setCue({ key: "speech", motion: "joyful", speaking: true });
	h.step(1000);
	expect(h.model.render).toHaveBeenLastCalledWith(1, "joyful", 1, true);
	h.step(33000);
	expect(h.model.render).toHaveBeenLastCalledWith(33, "joyful", 33, true);
	h.controller.setCue(null);
	expect(h.model.render).toHaveBeenLastCalledWith(33, "neutral", 0);
	h.step(34000);
	expect(h.model.render).toHaveBeenLastCalledWith(34, "neutral", 1);
	h.controller.dispose();
});

test("a rendering failure stops the idle loop and reports once", () => {
	const frames = new Map<number, FrameRequestCallback>();
	const onError = vi.fn();
	const controller = createAvatarPlayback(
		{
			beginMotion() {},
			render: () => {
				throw new Error("context lost");
			},
		},
		{
			now: () => 0,
			requestFrame: (fn) => {
				frames.set(1, fn);
				return 1;
			},
			cancelFrame: (id) => frames.delete(id),
			onError,
		},
	);
	frames.get(1)!(1000);
	controller.redraw();
	expect(onError).toHaveBeenCalledOnce();
	expect(frames.size).toBe(0);
});
