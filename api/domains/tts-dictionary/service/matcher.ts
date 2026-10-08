import type { Entry } from "../contracts";
/** Longest headword wins; matching is plain substring replacement. */
export function compile(entries: readonly Entry[]) {
	const groups = new Map<string, Entry[]>();
	for (const entry of entries) {
		const first = [...entry.written][0]!;
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
			const hit = groups.get(first)?.find((e) => text.startsWith(e.written, i));
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
