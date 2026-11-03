import { afterEach, expect, test, vi } from "vitest";
import {
	analyseAssistantSpeech,
	readAssistantMouth,
} from "../assistant-speech";

const releases: Array<() => void> = [];
afterEach(() => {
	for (const release of releases.splice(0)) release();
	expect(readAssistantMouth()).toBe(0);
});
function input() {
	let amplitude = 0;
	let active = true;
	const analyser = {
		fftSize: 0,
		getFloatTimeDomainData: vi.fn((out: Float32Array) => out.fill(amplitude)),
		disconnect: vi.fn(),
	};
	const context = {
		state: "running",
		currentTime: 0,
		createAnalyser: () => analyser,
	};
	const output = { connect: vi.fn(), disconnect: vi.fn() };
	const release = analyseAssistantSpeech(
		context as unknown as AudioContext,
		output as unknown as AudioNode,
		() => active,
	);
	releases.push(release);
	return {
		context,
		output,
		analyser,
		release,
		amplitude: (value: number) => {
			amplitude = value;
		},
		active: (value: boolean) => {
			active = value;
		},
		step: () => {
			context.currentTime += 1 / 24;
			return readAssistantMouth();
		},
	};
}

test("silence and small noise keep the mouth shut; speech has smoothing and a hard upper bound", () => {
	const h = input();
	expect(h.step()).toBe(0);
	h.amplitude(0.007);
	expect(h.step()).toBe(0);
	h.amplitude(0.1);
	const first = h.step();
	expect(first).toBeGreaterThan(0);
	expect(first).toBeLessThan(0.46);
	expect(h.step()).toBeGreaterThan(first);
	h.amplitude(1);
	for (let i = 0; i < 50; i++) expect(h.step()).toBeLessThanOrEqual(0.7);
	h.amplitude(0);
	expect(h.step()).toBeGreaterThan(0);
	for (let i = 0; i < 30; i++) h.step();
	expect(h.step()).toBe(0);
});

test("stopped, suspended and disconnected audio immediately closes, even with old analyser data", () => {
	const h = input();
	h.amplitude(0.2);
	expect(h.step()).toBeGreaterThan(0);
	h.active(false);
	expect(h.step()).toBe(0);
	h.active(true);
	expect(h.step()).toBeGreaterThan(0);
	h.context.state = "suspended";
	expect(h.step()).toBe(0);
	h.context.state = "running";
	expect(h.step()).toBeGreaterThan(0);
	h.release();
	expect(readAssistantMouth()).toBe(0);
	h.release();
	expect(h.output.disconnect).toHaveBeenCalledExactlyOnceWith(h.analyser);
	// The tap never connects to the speakers itself.
	expect(h.output.connect).toHaveBeenCalledExactlyOnceWith(h.analyser);
	expect(h.analyser.disconnect).toHaveBeenCalledOnce();
});

test("independent speech sources share one pull input and repeated attachment leaves no stale values", () => {
	for (let i = 0; i < 8; i++) {
		const tts = input();
		const live = input();
		tts.amplitude(0.1);
		live.amplitude(0.2);
		tts.context.currentTime = live.context.currentTime = 1;
		expect(readAssistantMouth()).toBeGreaterThan(0.6);
		live.release();
		expect(readAssistantMouth()).toBeLessThan(0.5);
		tts.release();
		expect(readAssistantMouth()).toBe(0);
	}
});
