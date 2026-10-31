import {
	act,
	cleanup,
	fireEvent,
	renderHook,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useTimerTone } from "../useTimerTone";

const fake = vi.hoisted(() => ({
	output: {
		startOutput: vi.fn(async () => {}),
		play: vi.fn(),
		stopPlayback: vi.fn(),
		stop: vi.fn(async () => {}),
	},
	create: vi.fn(),
}));
vi.mock("../controller", () => ({
	createAudioController: (...args: unknown[]) => {
		fake.create(...args);
		return fake.output;
	},
}));
afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});

test("configured output is reused and tone completion follows the actual ended callback", async () => {
	const callbacks: Array<() => void> = [];
	fake.output.play.mockImplementation(async (_bytes, ended, options) => {
		callbacks.push(ended);
		options.onStarted();
	});
	const hook = renderHook(() =>
		useTimerTone({ outputDevice: "speaker-2", outputVolume: 0.4 }),
	);
	const signal = new AbortController().signal;
	let completed = false;
	const first = hook.result.current.play(signal).then(() => {
		completed = true;
	});
	await waitFor(() => expect(fake.output.play).toHaveBeenCalledOnce());
	expect(completed).toBe(false);
	expect(fake.create.mock.calls[0]?.[3]).toEqual({
		outputDevice: "speaker-2",
		keepAlive: false,
	});
	expect(fake.output.play.mock.calls[0]?.[2].volume).toBe(0.4);
	await act(async () => {
		callbacks[0]!();
		await first;
	});
	const next = hook.result.current.play(signal);
	await waitFor(() => expect(fake.output.play).toHaveBeenCalledTimes(2));
	await act(async () => {
		callbacks[1]!();
		await next;
	});
	expect(fake.create).toHaveBeenCalledOnce();
	hook.unmount();
	expect(fake.output.stop).toHaveBeenCalledOnce();
});

test("aborting a stalled output releases resources and rejects instead of reporting played", async () => {
	fake.output.startOutput.mockImplementation(() => new Promise<void>(() => {}));
	const hook = renderHook(() => useTimerTone({ outputVolume: 1 }));
	const abort = new AbortController();
	const playback = hook.result.current.play(abort.signal);
	const rejected = expect(playback).rejects.toThrow("audio_interrupted");
	abort.abort();
	await rejected;
	expect(fake.output.stop).toHaveBeenCalledOnce();
	expect(fake.output.play).not.toHaveBeenCalled();
});

test("a live session shares its output and aborting a tone leaves the microphone session running", async () => {
	const session = {
		play: vi.fn(async (_bytes, _ended, options) => {
			options.onStarted();
		}),
		stopPlayback: vi.fn(),
	};
	const hook = renderHook(() =>
		useTimerTone({ outputVolume: 0.5 }, () => session),
	);
	const abort = new AbortController();
	const playback = hook.result.current.play(abort.signal);
	const rejected = expect(playback).rejects.toThrow("audio_interrupted");
	await waitFor(() => expect(session.play).toHaveBeenCalledOnce());
	expect(session.play.mock.calls[0]?.[2].suppressInput).toBe(true);
	expect(fake.create).not.toHaveBeenCalled();
	abort.abort();
	await rejected;
	expect(session.stopPlayback).toHaveBeenCalledOnce();
	expect(fake.output.stop).not.toHaveBeenCalled();
});

test("a user gesture prepares the output before the deadline without playing a sound", async () => {
	const hook = renderHook(() => useTimerTone({ outputVolume: 1 }));
	expect(hook.result.current.ready).toBe(false);
	fireEvent.pointerDown(window);
	expect(fake.output.startOutput).not.toHaveBeenCalled();
	fireEvent.click(window);
	await waitFor(() => expect(fake.output.startOutput).toHaveBeenCalledOnce());
	await waitFor(() => expect(hook.result.current.ready).toBe(true));
	expect(fake.output.play).not.toHaveBeenCalled();
	fireEvent.keyUp(window, { key: "Enter" });
	expect(fake.create).toHaveBeenCalledOnce();
});

test("a later gesture retries preparation instead of caching a suspended output as ready", async () => {
	let resume!: () => void;
	fake.output.startOutput.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				resume = resolve;
			}),
	);
	const hook = renderHook(() => useTimerTone({ outputVolume: 1 }));
	fireEvent.click(window);
	expect(hook.result.current.ready).toBe(false);
	fireEvent.keyUp(window, { key: "Enter" });
	await waitFor(() => expect(hook.result.current.ready).toBe(true));
	expect(fake.output.startOutput).toHaveBeenCalledTimes(2);
	expect(fake.create).toHaveBeenCalledOnce();
	await act(async () => resume());
});

test("the beep ends before speech starts, and the completion message uses the same output", async () => {
	const ended: Array<() => void> = [];
	fake.output.play.mockImplementation(async (_bytes, done, options) => {
		ended.push(done);
		options.onStarted();
	});
	const spoken = new Uint8Array([1, 2, 3]);
	const speech = vi.fn(async () => spoken);
	const hook = renderHook(() =>
		useTimerTone({ outputVolume: 0.4 }, undefined, speech),
	);
	const signal = new AbortController().signal;
	const playing = hook.result.current.play(
		signal,
		"3分のタイマーが終了しました。",
	);
	await waitFor(() => expect(fake.output.play).toHaveBeenCalledOnce());
	expect(speech).not.toHaveBeenCalled();
	await act(async () => {
		ended[0]!();
	});
	await waitFor(() => expect(fake.output.play).toHaveBeenCalledTimes(2));
	expect(speech).toHaveBeenCalledWith(
		"3分のタイマーが終了しました。",
		expect.any(AbortSignal),
	);
	expect(fake.output.play.mock.calls[1]![0]).toBe(spoken);
	expect(fake.output.play.mock.calls[1]![2].suppressInput).toBe(true);
	await act(async () => {
		ended[1]!();
		await playing;
	});
});

test("unavailable speech leaves an already delivered beep successful", async () => {
	fake.output.play.mockImplementation(async (_bytes, done, options) => {
		options.onStarted();
		done();
	});
	const speech = vi.fn(async () => {
		throw new Error("tts_unavailable");
	});
	const hook = renderHook(() =>
		useTimerTone({ outputVolume: 1 }, undefined, speech),
	);
	await expect(
		hook.result.current.play(
			new AbortController().signal,
			"タイマーが終了しました。",
		),
	).resolves.toBeUndefined();
	expect(fake.output.play).toHaveBeenCalledOnce();
});

test("repeating alarms play only beeps and stop promptly without requesting speech again", async () => {
	vi.useFakeTimers();
	try {
		fake.output.play.mockImplementation(async (_bytes, done, options) => {
			options.onStarted();
			done();
		});
		const speech = vi.fn(async () => new Uint8Array([1]));
		const h = renderHook(() =>
			useTimerTone({ outputVolume: 1 }, undefined, speech),
		);
		const abort = new AbortController();
		const ringing = h.result.current.repeat(abort.signal);
		const stopped = expect(ringing).rejects.toThrow("audio_interrupted");
		await act(async () => vi.advanceTimersByTimeAsync(2500));
		expect(fake.output.play).toHaveBeenCalledOnce();
		await act(async () => vi.advanceTimersByTimeAsync(2500));
		expect(fake.output.play).toHaveBeenCalledTimes(2);
		abort.abort();
		await stopped;
		await act(async () => vi.advanceTimersByTimeAsync(10000));
		expect(fake.output.play).toHaveBeenCalledTimes(2);
		expect(speech).not.toHaveBeenCalled();
	} finally {
		vi.useRealTimers();
	}
});

test("keyup after a successful preparation does not start the output again", async () => {
	const hook = renderHook(() => useTimerTone({ outputVolume: 1 }));
	fireEvent.click(window);
	await waitFor(() => expect(hook.result.current.ready).toBe(true));
	for (let i = 0; i < 10; i++) fireEvent.keyUp(window, { key: "a" });
	expect(fake.output.startOutput).toHaveBeenCalledOnce();
});

test("a rejecting output is retried at most once every five seconds", async () => {
	vi.useFakeTimers();
	try {
		fake.output.startOutput.mockRejectedValue(new Error("blocked"));
		renderHook(() => useTimerTone({ outputVolume: 1 }));
		fireEvent.keyUp(window, { key: "a" });
		await vi.advanceTimersByTimeAsync(0);
		for (let i = 0; i < 10; i++) fireEvent.keyUp(window, { key: "a" });
		expect(fake.output.startOutput).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(5_000);
		fireEvent.keyUp(window, { key: "a" });
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.output.startOutput).toHaveBeenCalledTimes(2);
	} finally {
		vi.useRealTimers();
	}
});

test("a supplied notification waveform uses the same output and waits for its ended callback", async () => {
	const bytes = new Uint8Array([1, 2, 3]);
	const loadTone = vi.fn(async (_signal: AbortSignal) => bytes);
	let ended: (() => void) | undefined;
	fake.output.play.mockImplementation(async (_bytes, done, options) => {
		ended = done;
		options.onStarted();
	});
	const hook = renderHook(() => useTimerTone({ loadTone, outputVolume: 0.3 }));
	const abort = new AbortController();
	const delivered = vi.fn();
	const playback = hook.result.current.play(abort.signal, undefined, delivered);
	await waitFor(() => expect(fake.output.play).toHaveBeenCalledOnce());
	expect(loadTone).toHaveBeenCalledWith(abort.signal);
	expect(fake.output.play.mock.calls[0]?.[0]).toBe(bytes);
	expect(delivered).not.toHaveBeenCalled();
	await act(async () => {
		ended!();
		await playback;
	});
	expect(delivered).toHaveBeenCalledOnce();
});

test("a failed or cancelled asset load never sounds the beep or acknowledges delivery", async () => {
	const loadTone = vi.fn(async (_signal: AbortSignal): Promise<Uint8Array> => {
		throw new Error("asset_unavailable");
	});
	const hook = renderHook(() => useTimerTone({ loadTone }));
	const delivered = vi.fn();
	await expect(
		hook.result.current.play(
			new AbortController().signal,
			undefined,
			delivered,
		),
	).rejects.toThrow("asset_unavailable");
	expect(fake.output.play).not.toHaveBeenCalled();
	expect(delivered).not.toHaveBeenCalled();
	let complete!: (bytes: Uint8Array) => void;
	loadTone.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				complete = resolve;
			}),
	);
	const abort = new AbortController();
	const playback = hook.result.current.play(abort.signal, undefined, delivered);
	const rejected = expect(playback).rejects.toThrow("audio_interrupted");
	abort.abort();
	complete(new Uint8Array([1, 2]));
	await rejected;
	expect(fake.output.play).not.toHaveBeenCalled();
	expect(delivered).not.toHaveBeenCalled();
});

test("successful completion plays the selected tone then its voice on the same output; ordinary notices stay tone-only", async () => {
	const tone = new Uint8Array([1]),
		voice = new Uint8Array([2]);
	const loadTone = vi.fn(async () => tone),
		loadCompletion = vi.fn(async () => voice);
	const ended: Array<() => void> = [];
	fake.output.play.mockImplementation(async (_bytes, done, options) => {
		ended.push(done);
		options.onStarted();
	});
	const h = renderHook(() =>
		useTimerTone({ loadTone, loadCompletion, outputVolume: 0.4 }),
	);
	const trace = vi.fn();
	const playback = h.result.current.playCompletion(
		new AbortController().signal,
		trace,
	);
	await waitFor(() => expect(fake.output.play).toHaveBeenCalledOnce());
	expect(loadCompletion).not.toHaveBeenCalled();
	await act(async () => {
		ended[0]!();
	});
	await waitFor(() => expect(fake.output.play).toHaveBeenCalledTimes(2));
	expect(fake.output.play.mock.calls.map((call) => call[0])).toEqual([
		tone,
		voice,
	]);
	expect(fake.output.play.mock.calls[1]?.[2]).toMatchObject({
		volume: 0.4,
		suppressInput: true,
	});
	await act(async () => {
		ended[1]!();
		await playback;
	});
	expect(trace.mock.calls).toEqual([
		["tone", "started"],
		["tone", "ended"],
		["completion", "started"],
		["completion", "ended"],
	]);
	const normal = h.result.current.play(new AbortController().signal);
	await waitFor(() => expect(fake.output.play).toHaveBeenCalledTimes(3));
	await act(async () => {
		ended[2]!();
		await normal;
	});
	expect(loadCompletion).toHaveBeenCalledOnce();
	expect(fake.create).toHaveBeenCalledOnce();
});

test("cancelling while the completion voice is loading discards late bytes after an already delivered tone", async () => {
	let complete!: (bytes: Uint8Array) => void;
	const loadCompletion = vi.fn(
		() =>
			new Promise<Uint8Array>((resolve) => {
				complete = resolve;
			}),
	);
	fake.output.play.mockImplementation(async (_bytes, done, options) => {
		options.onStarted();
		done();
	});
	const h = renderHook(() => useTimerTone({ loadCompletion }));
	const abort = new AbortController();
	const playback = h.result.current.playCompletion(abort.signal);
	const rejected = expect(playback).rejects.toThrow();
	await waitFor(() => expect(loadCompletion).toHaveBeenCalledOnce());
	abort.abort();
	complete(new Uint8Array([2]));
	await rejected;
	expect(fake.output.play).toHaveBeenCalledOnce();
});

test("a failing diagnostic observer does not interrupt the completion voice", async () => {
	fake.output.play.mockImplementation(async (_bytes, done, options) => {
		options.onStarted();
		done();
	});
	const h = renderHook(() =>
		useTimerTone({
			loadTone: async () => new Uint8Array([1]),
			loadCompletion: async () => new Uint8Array([2]),
		}),
	);
	await expect(
		h.result.current.playCompletion(new AbortController().signal, () => {
			throw new Error("diagnostic_unavailable");
		}),
	).resolves.toBeUndefined();
	expect(fake.output.play.mock.calls.map((call) => call[0][0])).toEqual([1, 2]);
});
