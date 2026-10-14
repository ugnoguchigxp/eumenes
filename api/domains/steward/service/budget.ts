import {
	EXCHANGES_PER_UNIT,
	MESSAGE_HEAD_BYTES,
	MESSAGE_MAX_BYTES,
	MESSAGE_TAIL_BYTES,
	UNIT_INPUT_BYTES,
} from "../contracts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MIDDLE = "\n（中略）\n";

/** A message as the steward reads it: whole, or its head and tail with a marker between. */
export type ClippedText = { text: string; truncated: boolean };

/**
 * Cuts a message that is longer than `MESSAGE_MAX_BYTES` to its first 4 KB and last 2 KB, on UTF-8 character
 * boundaries. The stored message is never changed; only what the steward is shown.
 */
export function clipMessage(text: string): ClippedText {
	const bytes = encoder.encode(text);
	if (bytes.length <= MESSAGE_MAX_BYTES) return { text, truncated: false };
	let head = MESSAGE_HEAD_BYTES;
	while (head > 0 && (bytes[head]! & 0xc0) === 0x80) head--;
	let tail = bytes.length - MESSAGE_TAIL_BYTES;
	while (tail < bytes.length && (bytes[tail]! & 0xc0) === 0x80) tail++;
	return {
		text: `${decoder.decode(bytes.slice(0, head))}${MIDDLE}${decoder.decode(bytes.slice(tail))}`,
		truncated: true,
	};
}

export const byteLength = (text: string) => encoder.encode(text).length;

/** The first `chars` characters of a text (never splits a character). */
export const clipChars = (text: string, chars: number) =>
	[...text].slice(0, chars).join("");

/**
 * The exchanges that fit one step's input: the first always, then in order while there are at most
 * `EXCHANGES_PER_UNIT` of them and their messages fit `UNIT_INPUT_BYTES`. One exchange alone is at most
 * 4 x 6 KB, so the first always fits. What is left over waits for the next unit.
 */
export function fitExchanges<T extends { bytes: number }>(
	candidates: readonly T[],
	options: { maxCount?: number; maxBytes?: number } = {},
): { fit: T[]; rest: T[] } {
	const maxCount = options.maxCount ?? EXCHANGES_PER_UNIT;
	const maxBytes = options.maxBytes ?? UNIT_INPUT_BYTES;
	const fit: T[] = [];
	let bytes = 0;
	let i = 0;
	for (; i < candidates.length; i++) {
		const next = candidates[i]!;
		if (
			fit.length > 0 &&
			(fit.length >= maxCount || bytes + next.bytes > maxBytes)
		)
			break;
		fit.push(next);
		bytes += next.bytes;
	}
	return { fit, rest: candidates.slice(i) };
}
