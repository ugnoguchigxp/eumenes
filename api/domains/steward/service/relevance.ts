/**
 * Whether something a forget names has to do with what the user asked to forget. The model chooses the refs, and a
 * model can err or be steered by text it read, so the host holds every target to the words of the request: a ref
 * (memory item, World claim or entity, goal) or an event that shares no content with the request is not forgotten.
 * Deterministic: Unicode NFKC, case-insensitive.
 */

const PARTICLES = /こと|[のをはがとにでもへ]/gu;
/** Everything that is not a letter, a digit or a mark separates words. */
const SEPARATORS = /[^\p{L}\p{N}\p{M}]+/gu;
const ASCII_WORD = /^[a-z0-9]+$/;
const HIRAGANA = /^\p{Script=Hiragana}$/u;

const fold = (text: string) => text.normalize("NFKC").toLowerCase();
const strip = (text: string) => fold(text).replace(SEPARATORS, "");

/**
 * The content units of a text: the whole ASCII words of two or more characters and the bigrams of the other letters.
 * Whitespace, punctuation and the common particles cut the text into pieces first, so no bigram spans them. A bigram
 * of two hiragana (した, たい, です) is grammar, not content: those count only as trigrams.
 */
export function contentUnits(text: string): Set<string> {
	const units = new Set<string>();
	const pieces = fold(text)
		.replace(PARTICLES, " ")
		.replace(SEPARATORS, " ")
		.split(" ");
	for (const piece of pieces) {
		for (const run of piece.match(/[a-z0-9]+|[^a-z0-9]+/g) ?? []) {
			if (ASCII_WORD.test(run)) {
				if (run.length >= 2) units.add(run);
				continue;
			}
			const chars = [...run];
			for (let i = 0; i + 1 < chars.length; i++) {
				const plain = HIRAGANA.test(chars[i]!) && HIRAGANA.test(chars[i + 1]!);
				if (!plain) units.add(chars[i]! + chars[i + 1]!);
				else if (i + 2 < chars.length && HIRAGANA.test(chars[i + 2]!))
					units.add(chars[i]! + chars[i + 1]! + chars[i + 2]!);
			}
		}
	}
	return units;
}

/**
 * `name` is in `text`: a name with other than ASCII letters is contained in it; an ASCII name (Eumenes, LARM) is in it
 * as whole words, so "ai" is not found in "maintain". Names under two characters are never found.
 */
export function mentions(text: string, name: string): boolean {
	const stripped = strip(name);
	if ([...stripped].length < 2) return false;
	if (!ASCII_WORD.test(stripped)) return strip(text).includes(stripped);
	const need = contentUnits(name);
	const have = contentUnits(text);
	return need.size > 0 && [...need].every((unit) => have.has(unit));
}

/**
 * `terms` (the names, aliases or text the model was shown of one target) have to do with `request` when one of them is
 * in it (`mentions`), or they share at least one content unit.
 */
export function relatedToRequest(
	request: string,
	terms: readonly string[],
): boolean {
	if (terms.some((term) => mentions(request, term))) return true;
	const wanted = contentUnits(request);
	if (wanted.size === 0) return false;
	for (const term of terms)
		for (const unit of contentUnits(term)) if (wanted.has(unit)) return true;
	return false;
}
