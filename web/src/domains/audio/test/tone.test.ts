import { expect, test } from "vitest";
import { TIMER_TONE, timerTonePcm, timerToneWav } from "../tone";

test("timer tone is a 0.6s 24kHz PCM16 wav with faded ends", () => {
	const pcm = timerTonePcm();
	expect(pcm.length).toBe(TIMER_TONE.sampleRate * TIMER_TONE.seconds);
	expect(pcm[0]).toBe(0);
	const peak = pcm.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
	expect(peak).toBeGreaterThan(4000);
	expect(peak).toBeLessThanOrEqual(
		Math.round(32767 * TIMER_TONE.amplitude) + 1,
	);
	expect(Math.abs(pcm[pcm.length - 1]!)).toBeLessThan(20);
	const wav = timerToneWav(pcm);
	expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
	expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
	expect(wav.length).toBe(44 + pcm.length * 2);
});
