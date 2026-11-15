import { afterEach, expect, test, vi } from "vitest";
import { createAudioController } from "..";
import { post, stubWorkletNode, workletModule } from "./worklet-fake";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

test.each([
	{ mode: "half-duplex", volume: 1, gated: true },
	{ mode: "timer-tone", volume: 1, gated: true },
	{ mode: "half-duplex", volume: 0, gated: false },
	{ mode: "barge-in", volume: 0, gated: false },
])(
	"$mode at volume $volume gates the microphone only for audible output",
	async ({ mode, volume, gated }) => {
		const nodes = stubWorkletNode();
		const sources: Array<{ onended: (() => void) | null }> = [];
		vi.stubGlobal("navigator", {
			mediaDevices: {
				getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
			},
		});
		class Context {
			sampleRate = 48000;
			destination = {};
			audioWorklet = workletModule;
			async resume() {}
			async close() {}
			createMediaStreamSource() {
				return { connect() {}, disconnect() {} };
			}
			async decodeAudioData() {
				return {};
			}
			createGain() {
				return { gain: { value: 1 }, connect() {}, disconnect() {} };
			}
			createBufferSource() {
				const source = {
					onended: null as (() => void) | null,
					buffer: null as unknown,
					connect() {},
					start() {},
					stop() {},
					disconnect() {},
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
			post(
				nodes[0],
				Float32Array.from({ length: 2048 }, (_, i) =>
					Math.floor(i / 8) % 2 ? value : -value,
				),
			);
		const utterance = (frames = 7) => {
			for (let i = 0; i < frames; i++) feed(0.2);
			for (let i = 0; i < 18; i++) feed(0);
			feed(0.2);
		};
		await audio.play(new Uint8Array(44), () => {}, {
			volume,
			suppressInput: mode === "timer-tone",
		});
		utterance();
		const first = gated ? 0 : 1;
		expect([speech, segments]).toEqual([first, first]);
		sources[0]?.onended?.();
		utterance();
		const second = gated ? 0 : 2;
		expect([speech, segments]).toEqual([second, second]);
		vi.spyOn(performance, "now").mockReturnValue(performance.now() + 1000);
		utterance();
		expect([speech, segments]).toEqual([second + 1, second + 1]);
		half = false;
		await audio.play(new Uint8Array(44), () => {});
		// Barge-in over our own reply takes clearer, longer speech (0.4 s) than a normal start.
		utterance(7);
		expect([speech, segments]).toEqual([second + 1, second + 1]);
		utterance(12);
		expect([speech, segments]).toEqual([second + 2, second + 2]);
		await audio.stop();
	},
);
