import type { Entry } from "../contracts";
const word = /[A-Za-z0-9]/;
const latinEnding = /[A-Za-z]$/;
const pluralEnding = /^s(?![A-Za-z0-9])/i;
/**
 * Longest headword wins. Headwords that begin or end with a Latin letter or
 * digit match at word boundaries. A final s can extend a Latin headword.
 */
export function compile(entries: readonly Entry[]) {
	const exact = new Map(entries.map((entry) => [entry.written, entry]));
	const groups = new Map<string, Array<Entry & { folded: string }>>();
	for (const entry of entries) {
		const first = String.fromCodePoint(entry.written.codePointAt(0)!);
		const key = first.toLowerCase();
		const group = groups.get(key) ?? [];
		group.push({ ...entry, folded: entry.written.toLowerCase() });
		groups.set(key, group);
	}
	for (const group of groups.values())
		group.sort(
			(a, b) =>
				b.written.length - a.written.length || (a.written < b.written ? -1 : 1),
		);
	return (text: string) => {
		let out = "";
		for (let i = 0; i < text.length;) {
			const first = String.fromCodePoint(text.codePointAt(i)!);
			let next = i + first.length;
			let spoken = first;
			for (const entry of groups.get(first.toLowerCase()) ?? []) {
				const end = i + entry.written.length;
				const original = text.slice(i, end);
				// Fold the candidate span so expanding lowercase forms do not move source offsets.
				if (original.toLowerCase() !== entry.folded) continue;
				if (word.test(entry.written[0]!) && word.test(text[i - 1] ?? ""))
					continue;
				const plural =
					latinEnding.test(entry.written) &&
					pluralEnding.test(text.slice(end, end + 2));
				if (
					!plural &&
					word.test(entry.written.at(-1)!) &&
					word.test(text[end] ?? "")
				)
					continue;
				// Case variants can already coexist in the saved dictionary.
				spoken = (exact.get(original) ?? entry).spoken;
				if (plural && spoken)
					spoken += latinEnding.test(spoken) ? text.charAt(end) : "ズ";
				next = end + (plural ? 1 : 0);
				break;
			}
			out += spoken;
			i = next;
		}
		return out;
	};
}
