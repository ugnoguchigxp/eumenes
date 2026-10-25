/** The connected ASR's measured and documented per-request audio envelope. */
const ASR_SECONDS = 12;
const tag = (wav: Uint8Array, offset: number) =>
	String.fromCharCode(...wav.subarray(offset, offset + 4));

/** Prefer a short quiet span near the limit so a boundary does not cut through a spoken word. */
function quietBoundary(
	view: DataView,
	start: number,
	capacity: number,
	rate: number,
	align: number,
) {
	const frame = Math.ceil(rate * 0.02) * align;
	const lower = start + Math.max(frame, capacity - rate * align * 2);
	let quiet = 0;
	for (let end = start + capacity; end - frame >= lower; end -= frame) {
		let sum = 0;
		for (let i = end - frame; i < end; i += 2) {
			const value = view.getInt16(i, true) / 32768;
			sum += value * value;
		}
		quiet = Math.sqrt(sum / (frame / 2)) < 0.008 ? quiet + 1 : 0;
		// A phoneme may contain a short low-energy gap. Require 200 ms, not a word-internal pause.
		if (quiet === 10) return end + frame * 9 - start;
	}
	return capacity;
}

/** Lossless PCM framing only; text interpretation remains the conversation model's job. */
export function asrWavSegments(wav: Uint8Array): Uint8Array[] {
	if (tag(wav, 0) !== "RIFF" || tag(wav, 8) !== "WAVE") return [wav];
	const header = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
	let blockAlign = 0,
		sampleRate = 0,
		pcm16 = false;
	for (let offset = 12; offset + 8 <= wav.length;) {
		const length = header.getUint32(offset + 4, true);
		const start = offset + 8;
		if (start + length > wav.length) return [wav];
		if (tag(wav, offset) === "fmt " && length >= 16) {
			const format = header.getUint16(start, true);
			if (format !== 1 && format !== 3) return [wav];
			sampleRate = header.getUint32(start + 4, true);
			blockAlign = header.getUint16(start + 12, true);
			pcm16 =
				format === 1 &&
				header.getUint16(start + 14, true) === 16 &&
				blockAlign % 2 === 0;
			if (header.getUint32(start + 8, true) !== sampleRate * blockAlign)
				return [wav];
		}
		if (tag(wav, offset) === "data") {
			if (!sampleRate || !blockAlign || length % blockAlign) return [wav];
			const capacity = sampleRate * blockAlign * ASR_SECONDS;
			if (length <= capacity) return [wav];
			const suffix = wav.subarray(start + length + (length % 2));
			const result: Uint8Array[] = [];
			for (let position = 0; position < length;) {
				const size =
					pcm16 && length - position > capacity
						? quietBoundary(
								header,
								start + position,
								capacity,
								sampleRate,
								blockAlign,
							)
						: Math.min(capacity, length - position);
				const part = new Uint8Array(start + size + (size % 2) + suffix.length);
				part.set(wav.subarray(0, start));
				part.set(
					wav.subarray(start + position, start + position + size),
					start,
				);
				part.set(suffix, start + size + (size % 2));
				const fields = new DataView(part.buffer);
				fields.setUint32(4, part.length - 8, true);
				fields.setUint32(offset + 4, size, true);
				result.push(part);
				position += size;
			}
			return result;
		}
		offset = start + length + (length % 2);
	}
	return [wav];
}
