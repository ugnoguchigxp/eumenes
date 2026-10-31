/** Whitespace in the ASCII, Unicode and ideographic (U+3000) sense. */
const SPACE = /[\s　]/u;
/** Punctuation (after NFKC, so full-width marks count): a model drops or adds it freely. */
const PUNCTUATION = /\p{P}/u;

/** A character's NFKC form without its whitespace and punctuation ("" for those). */
const fold = (char: string): string => {
	if (SPACE.test(char)) return "";
	const folded = char.normalize("NFKC").replace(/[\s　]/gu, "");
	return PUNCTUATION.test(folded) ? "" : folded;
};

/**
 * Finds `quote` in `text` and returns the span of `text` it stands for (UTF-16 offsets), or null.
 * A model copies words, not bytes: it may drop or add spaces and punctuation and switch between
 * full-width and half-width forms. The span is always a literal slice of `text`, which is what the
 * library's evidence check requires.
 *
 * 1. Exact match.
 * 2. Both sides folded character by character (NFKC, no whitespace, no punctuation), then mapped back
 *    to the span of original characters the match covers. Characters are code points, so surrogate
 *    pairs stay whole.
 */
export function locateQuoteSpan(
	text: string,
	quote: string,
): { start: number; end: number } | null {
	if (quote.length === 0) return null;
	const exact = text.indexOf(quote);
	if (exact >= 0) return { start: exact, end: exact + quote.length };
	let folded = "";
	// For every UTF-16 unit of `folded`: where the original character it came from starts and ends.
	const starts: number[] = [];
	const ends: number[] = [];
	let at = 0;
	for (const char of text) {
		const next = at + char.length;
		const piece = fold(char);
		for (let i = 0; i < piece.length; i++) {
			starts.push(at);
			ends.push(next);
		}
		folded += piece;
		at = next;
	}
	let wanted = "";
	for (const char of quote) wanted += fold(char);
	if (wanted.length === 0) return null;
	const found = folded.indexOf(wanted);
	if (found < 0) return null;
	return {
		start: starts[found] as number,
		end: ends[found + wanted.length - 1] as number,
	};
}

/** NFKC, no whitespace, no punctuation: the form two texts are compared in. */
const codePoints = (text: string): string[] =>
	Array.from(Array.from(text, (char) => fold(char).toLowerCase()).join(""));

/** Characters left after NFKC and whitespace/punctuation removal. */
export function foldedLength(text: string): number {
	return codePoints(text).length;
}

/**
 * A key as the host stores it (`semanticKey`): lower case `[a-z0-9._-]`, at most 64 characters. null when
 * the model's key is not usable as it is (nothing is repaired but the case and surrounding space).
 */
export function normalizeKey(key: string): string | null {
	const normalized = key.trim().toLowerCase();
	return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized) ? normalized : null;
}

const encoder = new TextEncoder();
const bytesOf = (text: string): number => encoder.encode(text).length;

/**
 * The part of a message an item is recorded to stand on, at most `maxBytes` of UTF-8 cut at character boundaries
 * (the library caps a quote at 1024 bytes). A quote that was found is kept (its beginning when it is too long). With
 * none, the whole message when it fits; otherwise the window sharing the most adjacent-character pairs with
 * `hint` (the fact's own words), the first window when nothing is shared.
 */
export function evidenceWindow(
	text: string,
	span: { start: number; end: number } | null,
	hint: string,
	maxBytes: number,
): { start: number; end: number } {
	const chars = Array.from(text);
	// UTF-16 offset of every code point, and one past the end.
	const offsets: number[] = [];
	let offset = 0;
	for (const char of chars) {
		offsets.push(offset);
		offset += char.length;
	}
	offsets.push(offset);
	const sizes = chars.map(bytesOf);
	const fit = (from: number, until: number): number => {
		let bytes = 0;
		let at = from;
		while (at < until && bytes + (sizes[at] as number) <= maxBytes) {
			bytes += sizes[at] as number;
			at++;
		}
		return at;
	};
	const indexOfOffset = (target: number) => offsets.indexOf(target);
	if (span) {
		const from = indexOfOffset(span.start);
		const until = indexOfOffset(span.end);
		if (from >= 0 && until > from) {
			const end = fit(from, until);
			return { start: offsets[from] as number, end: offsets[end] as number };
		}
	}
	const wholeEnd = fit(0, chars.length);
	if (wholeEnd === chars.length) return { start: 0, end: text.length };
	const wanted = bigramSet(hint);
	let best = { from: 0, end: wholeEnd, score: -1 };
	const step = 64;
	for (let from = 0; from < chars.length; from += step) {
		const end = fit(from, chars.length);
		if (end === from) continue;
		const have = bigramSet(chars.slice(from, end).join(""));
		let score = 0;
		for (const pair of wanted) if (have.has(pair)) score++;
		if (score > best.score) best = { from, end, score };
		if (end === chars.length) break;
	}
	return {
		start: offsets[best.from] as number,
		end: offsets[best.end] as number,
	};
}
function bigramSet(text: string): Set<string> {
	const chars = codePoints(text);
	const out = new Set<string>();
	for (let i = 0; i + 1 < chars.length; i++)
		out.add(`${chars[i]}${chars[i + 1]}`);
	return out;
}
