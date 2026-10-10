import { afterEach, expect, test, vi } from "vitest";
import { createAudioController } from "..";

afterEach(() => vi.unstubAllGlobals());

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
				data: Float32Array.from({ length: 128 }, (_, i) =>
					i % 2 ? 0.02 : -0.02,
				),
			});
		},
		feed(voiced: boolean, count: number) {
			for (let frame = 0; frame < count; frame++) {
				const samples = Float32Array.from(
					{ length: sampleRate / 10 },
					(_, i) => (voiced ? (i % 2 ? 0.02 : -0.02) : 0),
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
		mic.feed(false, 7);
		expect(segment).toHaveBeenCalledTimes(1);
		expect(speech).toHaveBeenCalledTimes(1);
		const bytes = segment.mock.calls[0]![0] as Uint8Array;
		expect(new DataView(bytes.buffer).getUint32(40, true)).toBe(127 * 1600 * 2);
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
		mic.feed(false, 7);
		expect(segment).toHaveBeenCalledTimes(1);
		const header = new DataView(
			(segment.mock.calls[0]![0] as Uint8Array).buffer,
		);
		expect(header.getUint32(24, true)).toBe(16000);
		expect(header.getUint32(40, true)).toBe(127 * 1600 * 2);
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
		mic.feed(false, 7);
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
		mic.feed(false, 14);
		expect(segment).not.toHaveBeenCalled();
		mic.feed(false, 1);
		expect(segment).toHaveBeenCalledTimes(1);
		expect(
			new DataView((segment.mock.calls[0]![0] as Uint8Array).buffer).getUint32(
				40,
				true,
			),
		).toBe(45 * 1600 * 2);
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
