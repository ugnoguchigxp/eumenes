import type { Entry } from "../contracts";
const word = /[A-Za-z0-9]/;
/**
 * Longest headword wins. Headwords that begin or end with a Latin letter or
 * digit only match as whole words, so "AI" never rewrites "MAIN".
 */
export function compile(entries: readonly Entry[]) {
	const groups = new Map<string, Entry[]>();
	for (const entry of entries) {
		const first = String.fromCodePoint(entry.written.codePointAt(0)!);
		const group = groups.get(first) ?? [];
		group.push(entry);
		groups.set(first, group);
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
			const hit = groups.get(first)?.find((e) => {
				if (!text.startsWith(e.written, i)) return false;
				const end = i + e.written.length;
				return !(
					(word.test(e.written[0]!) && word.test(text[i - 1] ?? "")) ||
					(word.test(e.written.at(-1)!) && word.test(text[end] ?? ""))
				);
			});
			if (hit) {
				out += hit.spoken;
				i += hit.written.length;
			} else {
				out += first;
				i += first.length;
			}
		}
		return out;
	};
}
