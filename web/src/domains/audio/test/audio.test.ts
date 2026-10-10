import { afterEach, expect, test, vi } from "vitest";
import { createAudioController, createAudioStore } from "..";

afterEach(() => vi.unstubAllGlobals());
test("pausing the microphone retains current output, resumes capture, and rejects callbacks from the old recorder", async () => {
	const tracks = [vi.fn(), vi.fn()],
		close = vi.fn(async () => {}),
		outputStop = vi.fn();
	let opened = 0,
		contexts = 0;
	const processors: Array<{
		onaudioprocess:
			| ((event: {
					inputBuffer: { getChannelData: () => Float32Array };
			  }) => void)
			| null;
		connect: () => void;
		disconnect: () => void;
	}> = [];
	vi.stubGlobal("navigator", {
		mediaDevices: {
			getUserMedia: async () => {
				const stop = tracks[opened++]!;
				return { getTracks: () => [{ stop }] };
			},
		},
	});
	class Context {
		sampleRate = 48000;
		destination = {};
		constructor() {
			contexts++;
		}
		async resume() {}
		close = close;
		createMediaStreamSource() {
			return { connect() {}, disconnect() {} };
		}
		createScriptProcessor() {
			const processor = { onaudioprocess: null, connect() {}, disconnect() {} };
			processors.push(processor);
			return processor;
		}
		async decodeAudioData() {
			return {};
		}
		createGain() {
			return { gain: { value: 1 }, connect() {}, disconnect() {} };
		}
		createBufferSource() {
			return {
				onended: null,
				buffer: null,
				connect() {},
				start() {},
				stop: outputStop,
			};
		}
	}
	vi.stubGlobal("AudioContext", Context);
	const segments = vi.fn();
	const audio = createAudioController(
		() => {},
		() => {},
		segments,
	);
	await audio.start();
	await audio.play(new Uint8Array(44), () => {});
	const stale = processors[0]!.onaudioprocess;
	audio.pauseInput();
	expect(tracks[0]).toHaveBeenCalledTimes(1);
	expect(close).not.toHaveBeenCalled();
	expect(outputStop).not.toHaveBeenCalled();
	await audio.start();
	expect(contexts).toBe(1);
	expect(opened).toBe(2);
	for (let index = 0; index < 30; index++)
		stale?.({
			inputBuffer: { getChannelData: () => new Float32Array(2048).fill(0.1) },
		});
	audio.pauseInput();
	expect(segments).not.toHaveBeenCalled();
	expect(tracks[1]).toHaveBeenCalledTimes(1);
	await audio.stop();
	expect(close).toHaveBeenCalledTimes(1);
	expect(outputStop).toHaveBeenCalledTimes(1);
});
test("playback volume includes mute and releases gain on completion and cancellation", async () => {
	const gains: Array<{
		gain: { value: number };
		connect: ReturnType<typeof vi.fn>;
		disconnect: ReturnType<typeof vi.fn>;
	}> = [];
	const sources: Array<{
		onended: (() => void) | null;
		buffer: unknown;
		connect: ReturnType<typeof vi.fn>;
		start: ReturnType<typeof vi.fn>;
		stop: ReturnType<typeof vi.fn>;
	}> = [];
	vi.stubGlobal("navigator", {
		mediaDevices: {
			getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
		},
	});
	class Context {
		sampleRate = 48000;
		destination = {};
		async resume() {}
		async close() {}
		createMediaStreamSource() {
			return { connect() {}, disconnect() {} };
		}
		createScriptProcessor() {
			return { connect() {}, disconnect() {} };
		}
		async decodeAudioData() {
			return {};
		}
		createGain() {
			const gain = {
				gain: { value: 1 },
				connect: vi.fn(),
				disconnect: vi.fn(),
			};
			gains.push(gain);
			return gain;
		}
		createBufferSource() {
			const source = {
				onended: null as (() => void) | null,
				buffer: null as unknown,
				connect: vi.fn(),
				start: vi.fn(),
				stop: vi.fn(),
			};
			sources.push(source);
			return source;
		}
	}
	vi.stubGlobal("AudioContext", Context);
	const audio = createAudioController(
		() => {},
		() => {},
		() => {},
	);
	await audio.start();
	const ended = vi.fn(),
		onStarted = vi.fn();
	await audio.play(new Uint8Array(44), ended, { volume: 0.4, onStarted });
	expect(sources[0]!.start).toHaveBeenCalledOnce();
	expect(onStarted).toHaveBeenCalledOnce();
	expect(gains[0]!.gain.value).toBe(0.4);
	expect(sources[0]!.connect).toHaveBeenCalledWith(gains[0]);
	sources[0]!.onended?.();
	expect(ended).toHaveBeenCalledOnce();
	expect(gains[0]!.disconnect).toHaveBeenCalledOnce();
	await audio.play(new Uint8Array(44), ended, { volume: 0 });
	expect(gains[1]!.gain.value).toBe(0);
	audio.stopPlayback();
	expect(sources[1]!.stop).toHaveBeenCalledOnce();
	expect(gains[1]!.disconnect).toHaveBeenCalledOnce();
	expect(ended).toHaveBeenCalledOnce();
	await audio.stop();
});
test("audio store instances do not leak state", () => {
	const first = createAudioStore(),
		second = createAudioStore();
	let secondUpdates = 0;
	const unsubscribe = second.subscribe(() => secondUpdates++);
	first.setState({ phase: "listening", level: 0.2 });
	expect(second.getState().phase).toBe("idle");
	expect(secondUpdates).toBe(0);
	unsubscribe();
});
test("three capture cycles release tracks and ignore late callbacks", async () => {
	let stopped = 0;
	const processors: Array<{
		onaudioprocess:
			| ((event: {
					inputBuffer: { getChannelData: () => Float32Array };
			  }) => void)
			| null;
	}> = [];
	const stream = {
		getTracks: () => [
			{
				stop: () => {
					stopped++;
				},
			},
		],
	};
	vi.stubGlobal("navigator", {
		mediaDevices: { getUserMedia: async () => stream },
	});
	class FakeContext {
		sampleRate = 48000;
		destination = {};
		async resume() {}
		async close() {}
		createMediaStreamSource() {
			return { connect: () => {}, disconnect: () => {} };
		}
		createScriptProcessor() {
			const processor = {
				onaudioprocess: null as (typeof processors)[number]["onaudioprocess"],
				connect: () => {},
				disconnect: () => {},
			};
			processors.push(processor);
			return processor;
		}
	}
	vi.stubGlobal("AudioContext", FakeContext);
	let speech = 0,
		segments = 0;
	const states: string[] = [];
	const levels: number[] = [];
	for (let cycle = 0; cycle < 3; cycle++) {
		const audio = createAudioController(
			(state) => {
				states.push(state.phase);
				levels.push(state.level);
			},
			() => speech++,
			() => segments++,
			{ silenceMs: 700 },
		);
		await audio.start();
		const processor = processors[cycle];
		if (!processor) throw new Error("processor_missing");
		const feed = (value: number) =>
			processor.onaudioprocess?.({
				inputBuffer: {
					getChannelData: () =>
						Float32Array.from({ length: 2048 }, (_, i) =>
							i % 2 ? value : -value,
						),
				},
			});
		for (let i = 0; i < 7; i++) feed(0.2);
		for (let i = 0; i < 18; i++) feed(0);
		feed(0.2);
		await audio.stop();
		expect(levels.at(-1)).toBe(0);
		feed(0.2);
	}
	expect([speech, segments, stopped]).toEqual([3, 3, 3]);
	expect(states.at(-1)).toBe("idle");
});

test("stopping playback while WAV decoding prevents a late start", async () => {
	let resolveDecode: ((buffer: AudioBuffer) => void) | undefined;
	let started = 0;
	vi.stubGlobal("navigator", {
		mediaDevices: {
			getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }),
		},
	});
	class FakeContext {
		sampleRate = 48000;
		destination = {};
		async resume() {}
		async close() {}
		createMediaStreamSource() {
			return { connect: () => {}, disconnect: () => {} };
		}
		createScriptProcessor() {
			return { connect: () => {}, disconnect: () => {} };
		}
		decodeAudioData() {
			return new Promise<AudioBuffer>((resolve) => {
				resolveDecode = resolve;
			});
		}
		createBufferSource() {
			return {
				buffer: null,
				onended: null,
				connect: () => {},
				start: () => started++,
				stop: () => {},
			};
		}
	}
	vi.stubGlobal("AudioContext", FakeContext);
	const audio = createAudioController(
		() => {},
		() => {},
		() => {},
	);
	await audio.start();
	const onStarted = vi.fn();
	const pending = audio.play(new Uint8Array(44), () => {}, { onStarted });
	expect(onStarted).not.toHaveBeenCalled();
	audio.stopPlayback();
	resolveDecode?.({} as AudioBuffer);
	await pending;
	expect(started).toBe(0);
	expect(onStarted).not.toHaveBeenCalled();
	await audio.stop();
});

test("without interruption the next response waits, while superseded waiting audio never starts", async () => {
	const sources: Array<{
		onended: (() => void) | null;
		start: () => void;
		stop: () => void;
		connect: () => void;
		buffer: unknown;
	}> = [];
	let started = 0;
	vi.stubGlobal("navigator", {
		mediaDevices: {
			getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }),
		},
	});
	class Context {
		sampleRate = 48000;
		destination = {};
		async resume() {}
		async close() {}
		createMediaStreamSource() {
			return { connect: () => {}, disconnect: () => {} };
		}
		createScriptProcessor() {
			return { connect: () => {}, disconnect: () => {} };
		}
		async decodeAudioData() {
			return {};
		}
		createBufferSource() {
			const s = {
				onended: null as (() => void) | null,
				start: () => {
					started++;
				},
				stop: () => {},
				connect: () => {},
				buffer: null as unknown,
			};
			sources.push(s);
			return s;
		}
	}
	vi.stubGlobal("AudioContext", Context);
	const audio = createAudioController(
		() => {},
		() => {},
		() => {},
	);
	await audio.start();
	await audio.play(new Uint8Array(44), () => {});
	let valid = true;
	const waiting = audio.play(new Uint8Array(44), () => {}, {
		waitForPrevious: true,
		shouldPlay: () => valid,
	});
	await Promise.resolve();
	expect(started).toBe(1);
	valid = false;
	sources[0]!.onended?.();
	await waiting;
	expect(started).toBe(1);
	await audio.play(new Uint8Array(44), () => {});
	const next = audio.play(new Uint8Array(44), () => {}, {
		waitForPrevious: true,
	});
	await Promise.resolve();
	expect(started).toBe(2);
	sources[1]!.onended?.();
	await next;
	expect(started).toBe(3);
	await audio.stop();
});

test("stopping while audio resume is pending never installs capture or reports a late error", async () => {
	let resume: (() => void) | undefined;
	let stopped = 0,
		installed = 0;
	const states: string[] = [];
	vi.stubGlobal("navigator", {
		mediaDevices: {
			getUserMedia: async () => ({
				getTracks: () => [{ stop: () => stopped++ }],
			}),
		},
	});
	class Context {
		sampleRate = 48000;
		destination = {};
		resume() {
			return new Promise<void>((resolve) => {
				resume = resolve;
			});
		}
		async close() {}
		createMediaStreamSource() {
			installed++;
			return { connect() {}, disconnect() {} };
		}
		createScriptProcessor() {
			return { connect() {}, disconnect() {} };
		}
	}
	vi.stubGlobal("AudioContext", Context);
	const audio = createAudioController(
		(state) => states.push(state.phase),
		() => {},
		() => {},
	);
	const starting = audio.start();
	await vi.waitFor(() => expect(resume).not.toBeUndefined());
	// getUserMedia resolves in the first microtask, before start awaits resume.
	await Promise.resolve();
	await audio.stop();
	resume!();
	await starting;
	expect(stopped).toBe(1);
	expect(installed).toBe(0);
	expect(states.at(-1)).toBe("idle");
});
test("an inaudible looping bed keeps the output awake until stop, unless disabled", async () => {
	const beds: Array<{
		loop: boolean;
		start: ReturnType<typeof vi.fn>;
		stop: ReturnType<typeof vi.fn>;
		buffer?: { data: Float32Array };
	}> = [];
	class Context {
		sampleRate = 8000;
		destination = {};
		resume = async () => {};
		close = async () => {};
		createBuffer(_channels: number, length: number) {
			const data = new Float32Array(length);
			return { getChannelData: () => data, data };
		}
		createBufferSource() {
			const bed = {
				loop: false,
				buffer: undefined,
				start: vi.fn(),
				stop: vi.fn(),
				connect: vi.fn(),
				disconnect: vi.fn(),
			};
			beds.push(bed);
			return bed;
		}
		createMediaStreamSource() {
			return { connect() {}, disconnect() {} };
		}
		createScriptProcessor() {
			return { connect() {}, disconnect() {} };
		}
	}
	vi.stubGlobal("AudioContext", Context);
	vi.stubGlobal("navigator", {
		mediaDevices: {
			getUserMedia: async () => ({ getTracks: () => [] }),
		},
	});
	const audio = createAudioController(
		() => {},
		() => {},
		() => {},
	);
	await audio.start();
	expect(beds).toHaveLength(1);
	expect(beds[0]!.loop).toBe(true);
	expect(beds[0]!.start).toHaveBeenCalledOnce();
	const peak = Math.max(...(beds[0]!.buffer?.data ?? []).map(Math.abs));
	expect(peak).toBeGreaterThan(1 / 32768);
	expect(peak).toBeLessThanOrEqual(1e-3);
	await audio.stop();
	expect(beds[0]!.stop).toHaveBeenCalledOnce();
	const quiet = createAudioController(
		() => {},
		() => {},
		() => {},
		{ keepAlive: false },
	);
	await quiet.start();
	expect(beds).toHaveLength(1);
	await quiet.stop();
});

test.each(["half-duplex", "timer-tone"])(
	"%s ignores the microphone during playback and its output tail",
	async (mode) => {
		type Process = (event: {
			inputBuffer: { getChannelData: () => Float32Array };
		}) => void;
		let process: Process | null = null;
		const sources: Array<{ onended: (() => void) | null }> = [];
		vi.stubGlobal("navigator", {
			mediaDevices: {
				getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
			},
		});
		class Context {
			sampleRate = 48000;
			destination = {};
			async resume() {}
			async close() {}
			createMediaStreamSource() {
				return { connect() {}, disconnect() {} };
			}
			createScriptProcessor() {
				const processor = {
					set onaudioprocess(value: Process | null) {
						process = value;
					},
					connect() {},
					disconnect() {},
				};
				return processor;
			}
			async decodeAudioData() {
				return {};
			}
			createBufferSource() {
				const source = {
					onended: null as (() => void) | null,
					buffer: null as unknown,
					connect() {},
					start() {},
					stop() {},
				};
				sources.push(source);
				return source;
			}
		}
		vi.stubGlobal("AudioContext", Context);
		let half = mode === "half-duplex";
		let speech = 0,
			segments = 0;
		const audio = createAudioController(
			() => {},
			() => speech++,
			() => segments++,
			{ keepAlive: false, halfDuplex: () => half, silenceMs: 700 },
		);
		await audio.start();
		const feed = (value: number) =>
			(process as Process | null)?.({
				inputBuffer: {
					getChannelData: () =>
						Float32Array.from({ length: 2048 }, (_, i) =>
							i % 2 ? value : -value,
						),
				},
			});
		const utterance = () => {
			for (let i = 0; i < 7; i++) feed(0.2);
			for (let i = 0; i < 18; i++) feed(0);
			feed(0.2);
		};
		await audio.play(new Uint8Array(44), () => {}, {
			suppressInput: mode === "timer-tone",
		});
		utterance();
		expect([speech, segments]).toEqual([0, 0]);
		sources[0]?.onended?.();
		utterance();
		expect([speech, segments]).toEqual([0, 0]);
		vi.spyOn(performance, "now").mockReturnValue(performance.now() + 1000);
		utterance();
		expect([speech, segments]).toEqual([1, 1]);
		half = false;
		await audio.play(new Uint8Array(44), () => {});
		utterance();
		expect([speech, segments]).toEqual([2, 2]);
		await audio.stop();
		vi.restoreAllMocks();
	},
);

function fakeAudioEnvironment(getUserMedia: (c: unknown) => Promise<unknown>) {
	class FakeContext extends EventTarget {
		sampleRate = 48000;
		state = "running";
		destination = {};
		async resume() {}
		async close() {}
		createMediaStreamSource() {
			return { connect: () => {}, disconnect: () => {} };
		}
		createScriptProcessor() {
			return { connect: () => {}, disconnect: () => {} };
		}
	}
	const contexts: FakeContext[] = [];
	vi.stubGlobal(
		"AudioContext",
		class extends FakeContext {
			constructor() {
				super();
				contexts.push(this);
			}
		},
	);
	const devices = Object.assign(new EventTarget(), {
		getUserMedia,
		enumerateDevices: async () => [] as MediaDeviceInfo[],
	});
	vi.stubGlobal("navigator", { mediaDevices: devices });
	return { contexts, devices };
}
function fakeStream() {
	const track = Object.assign(new EventTarget(), {
		stop() {},
		getSettings: () => ({ deviceId: "mic-1" }),
	});
	return {
		track,
		stream: { getTracks: () => [track], getAudioTracks: () => [track] },
	};
}

test("a microphone track ending reports mic_lost once and listeners are released", async () => {
	const { track, stream } = fakeStream();
	fakeAudioEnvironment(async () => stream);
	const lost = vi.fn();
	const audio = createAudioController(
		() => {},
		() => {},
		() => {},
		{ onLost: lost },
	);
	await audio.start();
	track.dispatchEvent(new Event("ended"));
	track.dispatchEvent(new Event("ended"));
	expect(lost).toHaveBeenCalledOnce();
	expect(lost).toHaveBeenCalledWith("mic_lost");
	await audio.stop();
});

test("removing the active device from the device list reports mic_lost", async () => {
	const { stream } = fakeStream();
	const env = fakeAudioEnvironment(async () => stream);
	const lost = vi.fn();
	const audio = createAudioController(
		() => {},
		() => {},
		() => {},
		{ onLost: lost },
	);
	await audio.start();
	env.devices.dispatchEvent(new Event("devicechange"));
	await vi.waitFor(() => expect(lost).toHaveBeenCalledWith("mic_lost"));
	await audio.stop();
	lost.mockClear();
	env.devices.dispatchEvent(new Event("devicechange"));
	await Promise.resolve();
	expect(lost).not.toHaveBeenCalled();
});

test("a suspended AudioContext is resumed once, then reported", async () => {
	const { stream } = fakeStream();
	const env = fakeAudioEnvironment(async () => stream);
	const lost = vi.fn();
	const audio = createAudioController(
		() => {},
		() => {},
		() => {},
		{ onLost: lost },
	);
	await audio.start();
	const context = env.contexts[0]!;
	context.resume = vi.fn(async () => {});
	context.state = "suspended";
	context.dispatchEvent(new Event("statechange"));
	await Promise.resolve();
	expect(context.resume).toHaveBeenCalledOnce();
	expect(lost).not.toHaveBeenCalled();
	context.dispatchEvent(new Event("statechange"));
	expect(lost).toHaveBeenCalledWith("audio_context_lost");
	await audio.stop();
});

test("a missing saved device falls back to the default microphone once", async () => {
	const { stream } = fakeStream();
	const calls: unknown[] = [];
	fakeAudioEnvironment(async (constraints) => {
		calls.push(constraints);
		if (calls.length === 1)
			throw Object.assign(new Error(""), { name: "OverconstrainedError" });
		return stream;
	});
	const notice = vi.fn();
	const audio = createAudioController(
		() => {},
		() => {},
		() => {},
		{ inputDevice: "gone", onNotice: notice },
	);
	await audio.start();
	expect(calls).toHaveLength(2);
	expect(JSON.stringify(calls[1])).not.toContain("exact");
	expect(notice).toHaveBeenCalledWith("saved_device_missing");
	await audio.stop();
});

test("capture uses an AudioWorklet and batches its blocks into 2048-sample frames", async () => {
	const { stream } = fakeStream();
	const env = fakeAudioEnvironment(async () => stream);
	const nodes: Array<{ port: { onmessage: ((e: unknown) => void) | null } }> =
		[];
	const addModule = vi.fn(async () => {});
	vi.stubGlobal(
		"AudioContext",
		class extends EventTarget {
			sampleRate = 48000;
			state = "running";
			destination = {};
			audioWorklet = { addModule };
			async resume() {}
			async close() {}
			createMediaStreamSource() {
				return { connect: () => {}, disconnect: () => {} };
			}
		},
	);
	vi.stubGlobal(
		"AudioWorkletNode",
		class {
			port: { onmessage: ((e: unknown) => void) | null } = { onmessage: null };
			constructor() {
				nodes.push(this);
			}
			connect() {}
			disconnect() {}
		},
	);
	void env;
	const speech = vi.fn();
	const audio = createAudioController(
		() => {},
		speech,
		() => {},
		{ threshold: 0.001 },
	);
	await audio.start();
	expect(addModule).toHaveBeenCalledOnce();
	const loud = Float32Array.from({ length: 128 }, (_, i) =>
		i % 2 ? 0.5 : -0.5,
	);
	for (let i = 0; i < 15; i++) nodes[0]!.port.onmessage?.({ data: loud });
	expect(speech).not.toHaveBeenCalled();
	for (let i = 0; i < 16 * 12; i++) nodes[0]!.port.onmessage?.({ data: loud });
	await vi.waitFor(() => expect(speech).toHaveBeenCalled());
	await audio.stop();
	expect(nodes[0]!.port.onmessage).toBeNull();
});

test("capture falls back to ScriptProcessorNode when the worklet cannot load", async () => {
	const { stream } = fakeStream();
	fakeAudioEnvironment(async () => stream);
	const processors: unknown[] = [];
	vi.stubGlobal(
		"AudioContext",
		class extends EventTarget {
			sampleRate = 48000;
			state = "running";
			destination = {};
			audioWorklet = {
				addModule: async () => {
					throw new Error("blocked");
				},
			};
			async resume() {}
			async close() {}
			createMediaStreamSource() {
				return { connect: () => {}, disconnect: () => {} };
			}
			createScriptProcessor() {
				const node = { connect() {}, disconnect() {}, onaudioprocess: null };
				processors.push(node);
				return node;
			}
		},
	);
	const audio = createAudioController(
		() => {},
		() => {},
		() => {},
	);
	await audio.start();
	expect(processors).toHaveLength(1);
	await audio.stop();
});

test("output preparation resumes an existing context that is waiting for a gesture", async () => {
	let unblock!: () => void;
	const resume = vi
		.fn()
		.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					unblock = resolve;
				}),
		)
		.mockResolvedValue(undefined);
	const close = vi.fn(async () => {});
	vi.stubGlobal(
		"AudioContext",
		class {
			resume = resume;
			close = close;
		},
	);
	const output = createAudioController(
		() => {},
		() => {},
		() => {},
		{ keepAlive: false },
	);
	const pending = output.startOutput();
	await output.startOutput();
	expect(resume).toHaveBeenCalledTimes(2);
	unblock();
	await pending;
	await output.stop();
	expect(close).toHaveBeenCalledOnce();
});

import {
	createIncrementalEncoder,
	encodeRecording,
	partialInterval,
} from "../controller";

function toneFrames(lengths: number[]): Float32Array[] {
	let n = 0;
	return lengths.map((length) =>
		new Float32Array(length).map(
			() => Math.sin(n++ * 0.05) * 0.4 + ((n % 7) - 3) * 0.01,
		),
	);
}

for (const rate of [48000, 44100, 16000]) {
	test(`incremental encoder matches encodeRecording at ${rate} Hz`, () => {
		const frames = toneFrames([2048, 2048, 2048, 2048, 1317, 91, 2048, 3]);
		const total = frames.reduce((sum, f) => sum + f.length, 0);
		const encoder = createIncrementalEncoder(rate);
		for (const frame of frames) {
			encoder.push(frame);
			const so_far = frames.slice(0, frames.indexOf(frame) + 1);
			const count = so_far.reduce((sum, f) => sum + f.length, 0);
			expect(encoder.wav()).toEqual(encodeRecording(so_far, count, rate));
		}
		expect(encoder.wav()).toEqual(encodeRecording(frames, total, rate));
	});
}

test("partial interval grows with utterance length and is capped", () => {
	expect(partialInterval(0)).toBe(0.6);
	expect(partialInterval(10)).toBeCloseTo(1.6);
	expect(partialInterval(60)).toBe(2);
});
