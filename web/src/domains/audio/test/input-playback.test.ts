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
		const gains: Array<{
			value: number;
			setTargetAtTime: ReturnType<typeof vi.fn>;
		}> = [];
		vi.stubGlobal("navigator", {
			mediaDevices: {
				getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
			},
		});
		class Context {
			sampleRate = 48000;
			currentTime = 0;
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
				const gain = { value: 1, setTargetAtTime: vi.fn() };
				gains.push(gain);
				return { gain, connect() {}, disconnect() {} };
			}
			createAnalyser() {
				return { fftSize: 0, disconnect() {} };
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
			assistantSpeech: mode !== "timer-tone",
			suppressInput: mode === "timer-tone",
		});
		utterance();
		if (mode !== "timer-tone" && (gated || volume === 0))
			expect(gains[0]!.setTargetAtTime).not.toHaveBeenCalled();
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
		await audio.play(new Uint8Array(44), () => {}, {
			assistantSpeech: true,
			volume: 0.6,
		});
		const replyGain = gains.at(-1)!;
		expect(replyGain.value).toBe(0.6);
		// Barge-in over our own reply takes clearer, longer speech (0.4 s) than a normal start.
		utterance(7);
		expect([speech, segments]).toEqual([second + 1, second + 1]);
		expect(replyGain.setTargetAtTime).not.toHaveBeenCalled();
		for (let i = 0; i < 12; i++) feed(0.2);
		expect(speech).toBe(second + 2);
		expect(replyGain.setTargetAtTime).toHaveBeenCalledExactlyOnceWith(
			0.006,
			0,
			0.005,
		);
		await audio.play(new Uint8Array(44), () => {}, { assistantSpeech: true });
		const nextGain = gains.at(-1)!;
		expect(nextGain.value).toBe(0.01);
		for (let i = 0; i < 18; i++) feed(0);
		expect([speech, segments]).toEqual([second + 2, second + 2]);
		expect(nextGain.setTargetAtTime).toHaveBeenCalledExactlyOnceWith(
			1,
			0,
			0.02,
		);
		for (let i = 0; i < 12; i++) feed(0.2);
		expect(nextGain.setTargetAtTime).toHaveBeenLastCalledWith(0.01, 0, 0.005);
		audio.pauseInput();
		expect(nextGain.setTargetAtTime).toHaveBeenLastCalledWith(1, 0, 0.02);
		await audio.stop();
	},
);
