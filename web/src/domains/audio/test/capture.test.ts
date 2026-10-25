import { afterEach, expect, test, vi } from "vitest";
import { createAudioController } from "..";
import { createSpeechClassifier } from "../controller/speech-classifier";

afterEach(() => vi.unstubAllGlobals());

/** A square wave well inside the speech band (resampling to 16 kHz keeps it). */
const tone = (i: number, value: number) =>
	Math.floor(i / 8) % 2 ? value : -value;

function recorder(sampleRate = 16000, useWorklet = false) {
	let receive:
		| ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void)
		| null = null;
	const stop = vi.fn();
	const resume = vi.fn(async () => {});
	vi.stubGlobal("navigator", {
		mediaDevices: {
			getUserMedia: async () => ({ getTracks: () => [{ stop }] }),
		},
	});
	class Context {
		sampleRate = sampleRate;
		audioWorklet = useWorklet ? { addModule: async () => {} } : undefined;
		destination = {};
		resume = resume;
		async close() {}
		createMediaStreamSource() {
			return { connect() {}, disconnect() {} };
		}
		createScriptProcessor() {
			return {
				set onaudioprocess(value: typeof receive) {
					receive = value;
				},
				connect() {},
				disconnect() {},
			};
		}
	}
	let port: { onmessage: ((event: { data: Float32Array }) => void) | null };
	if (useWorklet) {
		vi.stubGlobal(
			"AudioWorkletNode",
			class {
				port = (port = { onmessage: null });
				connect() {}
				disconnect() {}
			},
		);
	}
	vi.stubGlobal("AudioContext", Context);
	return {
		stop,
		resume,
		tail() {
			port.onmessage?.({
				data: Float32Array.from({ length: 128 }, (_, i) => tone(i, 0.02)),
			});
		},
		feed(voiced: boolean, count: number) {
			for (let frame = 0; frame < count; frame++) {
				const samples = Float32Array.from(
					{ length: sampleRate / 10 },
					(_, i) => (voiced ? tone(i, 0.02) : 0),
				);
				if (useWorklet) {
					port.onmessage?.({ data: samples });
					continue;
				}
				receive?.({
					inputBuffer: {
						getChannelData: () => samples,
					},
				});
			}
		},
	};
}

test("capture stays preparing until its first frame, including after resume", async () => {
	const mic = recorder();
	const state = vi.fn();
	const audio = createAudioController(
		state,
		() => {},
		() => {},
	);
	try {
		const starting = audio.start();
		expect(state.mock.lastCall?.[0].inputPhase).toBe("starting");
		await starting;
		expect(state.mock.lastCall?.[0].inputPhase).toBe("starting");
		mic.feed(false, 1);
		expect(state.mock.lastCall?.[0].inputPhase).toBe("ready");
		audio.pauseInput();
		expect(state.mock.lastCall?.[0].inputPhase).toBe("idle");
		await audio.start();
		expect(state.mock.lastCall?.[0].inputPhase).toBe("starting");
		mic.feed(false, 1);
		expect(state.mock.lastCall?.[0].inputPhase).toBe("ready");
	} finally {
		await audio.stop();
	}
	expect(state.mock.lastCall?.[0].inputPhase).toBe("idle");
});

test("cancelled microphone permission cannot make capture ready", async () => {
	const mic = recorder();
	let allow!: (stream: {
		getTracks: () => { stop: typeof mic.stop }[];
	}) => void;
	vi.stubGlobal("navigator", {
		mediaDevices: {
			getUserMedia: () =>
				new Promise((resolve) => {
					allow = resolve;
				}),
		},
	});
	const state = vi.fn();
	const audio = createAudioController(
		state,
		() => {},
		() => {},
	);
	const starting = audio.start();
	audio.pauseInput();
	allow({ getTracks: () => [{ stop: mic.stop }] });
	await starting;
	expect(state.mock.lastCall?.[0].inputPhase).toBe("idle");
	expect(mic.stop).toHaveBeenCalledTimes(1);
	await audio.stop();
});

test("microphone failure clears capture preparation", async () => {
	recorder();
	vi.stubGlobal("navigator", {
		mediaDevices: {
			getUserMedia: async () => {
				throw new Error("denied");
			},
		},
	});
	const state = vi.fn();
	const audio = createAudioController(
		state,
		() => {},
		() => {},
	);
	await expect(audio.start()).rejects.toThrow("denied");
	expect(state.mock.lastCall?.[0]).toMatchObject({
		phase: "error",
		inputPhase: "idle",
	});
	await audio.stop();
});

test("a continuous 12-second question stays intact until its final silence", async () => {
	const mic = recorder(),
		segment = vi.fn(),
		speech = vi.fn();
	const audio = createAudioController(() => {}, speech, segment, {
		silenceMs: 700,
	});
	try {
		await audio.start();
		mic.feed(true, 120);
		expect(segment).not.toHaveBeenCalled();
		mic.feed(false, 8);
		expect(segment).toHaveBeenCalledTimes(1);
		expect(speech).toHaveBeenCalledTimes(1);
		const bytes = segment.mock.calls[0]![0] as Uint8Array;
		expect(new DataView(bytes.buffer).getUint32(40, true)).toBe(128 * 1600 * 2);
	} finally {
		await audio.stop();
	}
});

test("worklet capture retains a long question and downsamples its complete audio", async () => {
	const mic = recorder(48000, true),
		segment = vi.fn();
	const audio = createAudioController(
		() => {},
		() => {},
		segment,
		{ silenceMs: 700 },
	);
	try {
		await audio.start();
		mic.feed(true, 120);
		expect(segment).not.toHaveBeenCalled();
		mic.feed(false, 8);
		expect(segment).toHaveBeenCalledTimes(1);
		const header = new DataView(
			(segment.mock.calls[0]![0] as Uint8Array).buffer,
		);
		expect(header.getUint32(24, true)).toBe(16000);
		expect(header.getUint32(40, true)).toBe(128 * 1600 * 2);
	} finally {
		await audio.stop();
	}
});

test("a failed microphone resume releases its stream so another start can recover", async () => {
	const mic = recorder(),
		segment = vi.fn();
	const audio = createAudioController(
		() => {},
		() => {},
		segment,
		{ silenceMs: 700 },
	);
	try {
		await audio.start();
		audio.pauseInput();
		mic.resume.mockRejectedValueOnce(new Error("resume_failed"));
		await expect(audio.start()).rejects.toThrow("resume_failed");
		expect(mic.stop).toHaveBeenCalledTimes(2);
		await audio.start();
		mic.feed(true, 10);
		mic.feed(false, 8);
		expect(segment).toHaveBeenCalledTimes(1);
	} finally {
		await audio.stop();
	}
});

test("pausing from the final segment callback cannot resend the same recording", async () => {
	const mic = recorder();
	const segment = vi.fn(() => audio.pauseInput());
	const audio = createAudioController(
		() => {},
		() => {},
		segment,
	);
	try {
		await audio.start();
		mic.feed(true, 10);
		audio.pauseInput();
		expect(segment).toHaveBeenCalledTimes(1);
		expect(mic.stop).toHaveBeenCalledTimes(1);
	} finally {
		await audio.stop();
	}
});

test("manual microphone pause retains the worklet's incomplete final frame", async () => {
	const mic = recorder(48000, true),
		segment = vi.fn();
	const audio = createAudioController(
		() => {},
		() => {},
		segment,
	);
	try {
		await audio.start();
		mic.feed(true, 10);
		mic.tail();
		audio.pauseInput();
		expect(segment).toHaveBeenCalledTimes(1);
		expect(
			new DataView((segment.mock.calls[0]![0] as Uint8Array).buffer).getUint32(
				40,
				true,
			),
		).toBe(Math.floor((48000 + 128) / 3) * 2);
	} finally {
		await audio.stop();
	}
});

test("the default silence interval keeps a one-second pause inside a single question", async () => {
	const mic = recorder(),
		segment = vi.fn();
	const audio = createAudioController(
		() => {},
		() => {},
		segment,
	);
	try {
		await audio.start();
		mic.feed(true, 10);
		mic.feed(false, 10);
		expect(segment).not.toHaveBeenCalled();
		mic.feed(true, 10);
		// Silence is decided per 32 ms window, so 1.5 s completes within the 16th frame.
		mic.feed(false, 15);
		expect(segment).not.toHaveBeenCalled();
		mic.feed(false, 1);
		expect(segment).toHaveBeenCalledTimes(1);
		expect(
			new DataView((segment.mock.calls[0]![0] as Uint8Array).buffer).getUint32(
				40,
				true,
			),
		).toBe(46 * 1600 * 2);
	} finally {
		await audio.stop();
	}
});

test("the capture limit sends the retained recording once, stops the microphone and reports the limit", async () => {
	const mic = recorder(),
		segment = vi.fn(),
		notice = vi.fn(),
		state = vi.fn();
	const audio = createAudioController(state, () => {}, segment, {
		onNotice: notice,
	});
	try {
		await audio.start();
		mic.feed(true, 650);
		expect(segment).toHaveBeenCalledTimes(1);
		expect((segment.mock.calls[0]![0] as Uint8Array).length).toBeLessThan(
			4_000_000,
		);
		expect(notice).toHaveBeenCalledWith("recording_limit");
		expect(mic.stop).toHaveBeenCalledTimes(1);
		expect(state.mock.lastCall?.[0].phase).toBe("idle");
	} finally {
		await audio.stop();
	}
});

test("overlapping starts share one model load, and stop during the load releases it", async () => {
	recorder();
	const created = vi.mocked(createSpeechClassifier);
	created.mockClear();
	let finish!: () => void;
	const close = vi.fn();
	created.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = () => resolve({ classify: () => 0, reset() {}, close });
			}),
	);
	const audio = createAudioController(
		() => {},
		() => {},
		() => {},
	);
	const first = audio.start();
	await vi.waitFor(() => expect(created).toHaveBeenCalledTimes(1));
	audio.pauseInput();
	const second = audio.start();
	await audio.stop();
	finish();
	await Promise.allSettled([first, second]);
	expect(created).toHaveBeenCalledTimes(1);
	expect(close).toHaveBeenCalled();
});

test("a model that fails while listening is reported and loaded again on the next start", async () => {
	const mic = recorder();
	const created = vi.mocked(createSpeechClassifier);
	created.mockClear();
	const close = vi.fn();
	created.mockImplementationOnce(async () => ({
		classify: () => Promise.reject(new Error("worker_gone")),
		reset() {},
		close,
	}));
	const lost = vi.fn();
	const segment = vi.fn();
	const audio = createAudioController(
		() => {},
		() => {},
		segment,
		{
			silenceMs: 700,
			onLost: lost,
		},
	);
	try {
		await audio.start();
		mic.feed(true, 2);
		await new Promise((resolve) => setTimeout(resolve, 0));
		mic.feed(true, 1);
		expect(lost).toHaveBeenCalledWith("voice_detector_unavailable");
		audio.pauseInput();
		await audio.start();
		expect(created).toHaveBeenCalledTimes(2);
		mic.feed(true, 10);
		mic.feed(false, 8);
		expect(segment).toHaveBeenCalledTimes(1);
	} finally {
		await audio.stop();
	}
});

test("previews start 1.8 s after confirmation, never for a short reply or in the trailing silence", async () => {
	const mic = recorder();
	const partial = vi.fn();
	const segment = vi.fn();
	const audio = createAudioController(
		() => {},
		() => {},
		segment,
		{
			silenceMs: 1500,
			onPartial: partial,
		},
	);
	try {
		await audio.start();
		// A short reply after a second of room tone (the pre-roll is not counted).
		mic.feed(false, 10);
		mic.feed(true, 3);
		mic.feed(false, 16);
		expect(segment).toHaveBeenCalledTimes(1);
		expect(partial).not.toHaveBeenCalled();
		// A long question (confirmed 0.2 s in): one preview once 1.8 s have passed since then.
		mic.feed(true, 22);
		expect(partial).toHaveBeenCalledTimes(1);
		const during = partial.mock.calls.length;
		mic.feed(false, 16);
		expect(partial).toHaveBeenCalledTimes(during);
		expect(segment).toHaveBeenCalledTimes(2);
	} finally {
		await audio.stop();
	}
});
