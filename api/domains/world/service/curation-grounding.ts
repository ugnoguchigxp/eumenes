/**
 * The host's check that a claim stands on what was said: an entity a claim is about must be
 * named in the very utterance the claim cites. A model that ties a claim to the entities it was
 * shown (or to words only an answer used) is not reporting the person.
 */

/** NFKC, trimmed, case-insensitive: the form names and utterances are compared in. */
export const groundingForm = (text: string): string =>
	text.normalize("NFKC").trim().toLowerCase();

const ASCII_ALNUM = /[a-z0-9]/;

/** True when `name` occurs in `utterance`; a Latin-script edge of the name needs a non-alphanumeric neighbour. */
function occurs(utterance: string, name: string): boolean {
	if (name === "") return false;
	const first = name[0]!;
	const last = name[name.length - 1]!;
	for (
		let at = utterance.indexOf(name);
		at !== -1;
		at = utterance.indexOf(name, at + 1)
	) {
		const before = utterance[at - 1];
		const after = utterance[at + name.length];
		if (
			ASCII_ALNUM.test(first) &&
			before !== undefined &&
			ASCII_ALNUM.test(before)
		)
			continue;
		if (
			ASCII_ALNUM.test(last) &&
			after !== undefined &&
			ASCII_ALNUM.test(after)
		)
			continue;
		return true;
	}
	return false;
}

/** True when any of the entity's names occurs in the utterance. */
export function named(utterance: string, names: readonly string[]): boolean {
	const text = groundingForm(utterance);
	return names.some((name) => occurs(text, groundingForm(name)));
}
