/** Where one segment's time went, in ms; numbers only (no audio, no text). */
export type SegmentTiming = {
	/** Length of the audio sent for recognition. */
	audioMs: number;
	/** Audio kept from before speech was confirmed. */
	preRollMs: number;
	/** Audio after the last voiced frame: the silence waited for before cutting the segment. */
	trailMs: number;
	/** From the last voiced frame to the segment being handed over (silence wait and detector lag). */
	endToSegmentMs: number;
	encodeMs: number;
	/** performance.now() when the segment was handed over (for the consumer's own clocks; not a duration). */
	handedAt: number;
};

/** Follows one recording: when speech was confirmed and last heard, by sample count and clock. */
export function createSegmentClock() {
	let preRoll = 0;
	let heardSample = 0;
	let heardAt = 0;
	return {
		confirmed(samples: number) {
			preRoll = samples;
			heardSample = samples;
			heardAt = performance.now();
		},
		heard(samples: number) {
			heardSample = samples;
			heardAt = performance.now();
		},
		/** Encodes the recording and says how long it took and how it was made up. */
		take(samples: number, rate: number, encode: () => Uint8Array) {
			const started = performance.now();
			const wav = encode();
			const ms = (count: number) => Math.round((count / rate) * 1000);
			const timing: SegmentTiming = {
				audioMs: ms(samples),
				preRollMs: ms(preRoll),
				trailMs: ms(Math.max(0, samples - heardSample)),
				endToSegmentMs: Math.round(started - heardAt),
				encodeMs: Math.round(performance.now() - started),
				handedAt: performance.now(),
			};
			return { wav, timing };
		},
	};
}
