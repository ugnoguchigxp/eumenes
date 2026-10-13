/** Whitespace in the ASCII, Unicode and ideographic (U+3000) sense. */
const SPACE = /[\s　]/u;

/** A character's NFKC form without its whitespace ("" for a space). */
const fold = (char: string): string =>
	SPACE.test(char) ? "" : char.normalize("NFKC").replace(/[\s　]/gu, "");

/**
 * Finds `quote` in `text` and returns the exact substring of `text` it stands for, or null.
 * A model copies words, not bytes: it may drop or add spaces and switch between full-width and
 * half-width forms. The returned string is always a literal slice of `text`, which is what the
 * library's evidence check requires.
 *
 * 1. Exact match.
 * 2. Both sides folded character by character (NFKC, no whitespace), then mapped back to the span of
 *    original characters the match covers. Characters are code points, so surrogate pairs stay whole.
 */
export function locateQuote(text: string, quote: string): string | null {
	if (quote.length === 0) return null;
	if (text.includes(quote)) return quote;
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
	const start = starts[found] as number;
	const end = ends[found + wanted.length - 1] as number;
	return text.slice(start, end);
}

/** NFKC, lower case, no whitespace: the form two texts are compared in. */
const codePoints = (text: string): string[] =>
	Array.from(Array.from(text, (char) => fold(char).toLowerCase()).join(""));

/** Characters left after NFKC and whitespace removal. */
export function foldedLength(text: string): number {
	return codePoints(text).length;
}
/**
 * Whether two texts share at least one pair of adjacent characters. A quote that has nothing in
 * common with the fact written from it cannot be its evidence (a planted sentence used as a pretext).
 */
export function sharesBigram(a: string, b: string): boolean {
	const bigrams = (text: string) => {
		const chars = codePoints(text);
		const out = new Set<string>();
		for (let i = 0; i + 1 < chars.length; i++)
			out.add(`${chars[i]}${chars[i + 1]}`);
		return out;
	};
	const left = bigrams(a);
	for (const pair of bigrams(b)) if (left.has(pair)) return true;
	return false;
}
