import { afterEach, expect, test, vi } from "vitest";
import { createAudioController, createAudioStore } from "..";

afterEach(() => vi.unstubAllGlobals());
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
	for (let cycle = 0; cycle < 3; cycle++) {
		const audio = createAudioController(
			(state) => states.push(state.phase),
			() => speech++,
			() => segments++,
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
		await audio.stop();
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
	const pending = audio.play(new Uint8Array(44), () => {});
	audio.stopPlayback();
	resolveDecode?.({} as AudioBuffer);
	await pending;
	expect(started).toBe(0);
	await audio.stop();
});
