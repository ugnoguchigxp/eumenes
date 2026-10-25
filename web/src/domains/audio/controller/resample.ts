export const TARGET_RATE = 16_000;
/**
 * Blackman-windowed sinc low-pass at 7.2 kHz, evaluated at output sample `index`. Plain
 * averaging leaves energy above the 8 kHz Nyquist that folds back over consonants.
 */
function lowPass(rate: number) {
	const ratio = rate / TARGET_RATE;
	const cutoff = (0.45 * TARGET_RATE) / rate;
	const half = Math.ceil(16 * ratio);
	// Output positions repeat a few fractional phases (one at 48 kHz, 160 at 44.1 kHz).
	const kernels = new Map<number, Float64Array>();
	const kernel = (phase: number) => {
		const key = Math.round(phase * 1e9);
		let weights = kernels.get(key);
		if (weights) return weights;
		weights = new Float64Array(2 * half + 1);
		let total = 0;
		for (let j = 0; j < weights.length; j++) {
			const d = j - half - phase;
			const x = 2 * Math.PI * cutoff * d;
			const k =
				Math.abs(d) >= half
					? 0
					: (d === 0 ? 1 : Math.sin(x) / x) *
						(0.42 +
							0.5 * Math.cos((Math.PI * d) / half) +
							0.08 * Math.cos((2 * Math.PI * d) / half));
			weights[j] = k;
			total += k;
		}
		for (let j = 0; j < weights.length; j++) weights[j]! /= total;
		kernels.set(key, weights);
		return weights;
	};
	return {
		half,
		at(read: (n: number) => number, index: number) {
			const center = index * ratio;
			const first = Math.floor(center) - half;
			const weights = kernel(center - Math.floor(center));
			let sum = 0;
			for (let j = 0; j < weights.length; j++)
				sum += weights[j]! * read(first + j);
			return sum;
		},
	};
}

/**
 * Streams microphone frames down to 16 kHz (rates at or below it pass through). Each push
 * returns the newly completed output samples; the result is identical however frames are split.
 */
export function createResampler(rate: number) {
	const ratio = rate / TARGET_RATE;
	const passthrough = rate <= TARGET_RATE;
	const filter = lowPass(rate);
	// Input still needed by an output window; `base` is the absolute index of input[0].
	let input = new Float32Array(16_384);
	let inputLength = 0;
	let base = 0;
	let total = 0;
	let produced = 0;
	const read = (n: number) =>
		n < base || n >= total ? 0 : (input[n - base] ?? 0);
	return {
		rate: passthrough ? rate : TARGET_RATE,
		push(frame: Float32Array): Float32Array {
			if (passthrough) return frame.slice();
			const keep = Math.max(base, Math.ceil(produced * ratio - filter.half));
			input.copyWithin(0, keep - base, inputLength);
			inputLength -= keep - base;
			base = keep;
			if (inputLength + frame.length > input.length) {
				const grown = new Float32Array(
					Math.max(input.length * 2, inputLength + frame.length),
				);
				grown.set(input.subarray(0, inputLength));
				input = grown;
			}
			input.set(frame, inputLength);
			inputLength += frame.length;
			total += frame.length;
			const out: number[] = [];
			while (Math.floor(produced * ratio + filter.half) < total)
				out.push(filter.at(read, produced++));
			return Float32Array.from(out);
		},
		/** The last windows, which run past the input so far; the missing input is silence. */
		tail(): Float32Array {
			if (passthrough) return new Float32Array(0);
			const end = Math.floor(total / ratio);
			const out = new Float32Array(Math.max(0, end - produced));
			for (let i = 0; i < out.length; i++)
				out[i] = filter.at(read, produced + i);
			return out;
		},
	};
}
