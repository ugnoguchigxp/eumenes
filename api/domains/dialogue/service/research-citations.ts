import { z } from "zod";

const sourceList = z.object({
	sources: z.array(z.object({ url: z.string() })),
});
const definition = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+["'(].*)?\s*$/;
const citationHead = /^\s*(?:ソース|出典|参考資料)\s*[:：]/;
const rawStops = new Set("<>\"'、。」』]\u0000");
const mark = "\u0000";

/** http(s) only, fragment ignored; anything unparsable is not a granted URL. */
function normalize(value: string) {
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		url.hash = "";
		return url.href;
	} catch {
		return null;
	}
}

/** Destination and optional title of `](...)` starting after the opening `(`. Null if malformed. */
function readDestination(text: string, start: number) {
	let i = start;
	let url: string;
	if (text[i] === "<") {
		const close = text.indexOf(">", i);
		if (close < 0) return null;
		url = text.slice(i + 1, close);
		i = close + 1;
	} else {
		let depth = 1;
		const from = i;
		for (; i < text.length; i++) {
			const c = text[i]!;
			if (/\s/.test(c)) break;
			if (c === "(") depth++;
			else if (c === ")" && --depth === 0) break;
		}
		url = text.slice(from, i);
		if (depth === 0) return { url, end: i + 1 };
	}
	while (/\s/.test(text[i] ?? "")) i++;
	if (text[i] === ")") return { url, end: i + 1 };
	const quote = text[i];
	const closer = quote === "(" ? ")" : quote;
	if (quote !== '"' && quote !== "'" && quote !== "(") return null;
	const close = text.indexOf(closer!, i + 1);
	if (close < 0) return null;
	i = close + 1;
	while (/\s/.test(text[i] ?? "")) i++;
	return text[i] === ")" ? { url, end: i + 1 } : null;
}

/** A raw URL run; parentheses stay only when balanced, trailing punctuation is left out. */
function readRawUrl(text: string, start: number) {
	let depth = 0;
	let i = start;
	for (; i < text.length; i++) {
		const c = text[i]!;
		if (/\s/.test(c) || rawStops.has(c)) break;
		if (c === "(") depth++;
		else if (c === ")") {
			if (depth === 0) break;
			depth--;
		}
	}
	while (i > start && /[.,;:!?(]/.test(text[i - 1]!)) i--;
	return i;
}

/** A research answer can link only to URLs in its host-verified report. */
export function researchCitations(text: string, projection?: string | null) {
	const allowed = new Set<string>();
	try {
		const parsed = sourceList.safeParse(JSON.parse(projection ?? "null"));
		if (parsed.success)
			for (const source of parsed.data.sources) {
				const url = normalize(source.url);
				if (url) allowed.add(url);
			}
	} catch {
		// Missing/failed reports grant no citations, including URLs from older turns.
	}
	const permitted = (url: string) => {
		const value = normalize(url);
		return value !== null && allowed.has(value);
	};
	return text
		.replaceAll(mark, "")
		.split(/\r?\n/)
		.flatMap((line) => {
			const ref = definition.exec(line);
			if (ref) return permitted(ref[1]!) ? [line] : [];
			const citationLine = citationHead.test(line);
			const kept: string[] = [];
			let removed = 0;
			const keep = (token: string) => {
				kept.push(token);
				return `${mark}${kept.length - 1}${mark}`;
			};
			let out = "";
			for (let i = 0; i < line.length;) {
				const image = line[i] === "!" && line[i + 1] === "[";
				const open = image ? i + 1 : i;
				if (line[open] === "[") {
					const close = line.indexOf("]", open + 1);
					const label = close < 0 ? "" : line.slice(open + 1, close);
					const dest =
						close > 0 && !label.includes("[") && line[close + 1] === "("
							? readDestination(line, close + 2)
							: null;
					if (dest) {
						if (!image && permitted(dest.url))
							out += keep(line.slice(i, dest.end));
						else {
							removed++;
							out += image || !citationLine ? label : "";
						}
						i = dest.end;
						continue;
					}
				}
				const auto = /^<(https?:\/\/[^>\s]+)>/.exec(line.slice(i));
				if (auto) {
					if (permitted(auto[1]!)) out += keep(auto[0]);
					else removed++;
					i += auto[0].length;
					continue;
				}
				out += line[i];
				i++;
			}
			// Raw URLs, including those that were only a label of a refused link.
			let filtered = "";
			for (let i = 0; i < out.length;) {
				const start = /^https?:\/\//i.test(out.slice(i, i + 8)) ? i : -1;
				if (start < 0) {
					filtered += out[i];
					i++;
					continue;
				}
				const end = readRawUrl(out, i);
				const url = out.slice(i, end);
				if (permitted(url)) {
					kept.push(url);
					filtered += `${mark}${kept.length - 1}${mark}`;
				} else removed++;
				i = Math.max(end, i + 1);
			}
			filtered = filtered.replace(
				new RegExp(`${mark}(\\d+)${mark}`, "g"),
				(_, n: string) => kept[Number(n)]!,
			);
			if (citationLine && removed > 0 && kept.length === 0) return [];
			return [
				citationLine
					? filtered.replace(/([:：])[\s、,]+/g, "$1").replace(/[\s、,]+$/, "")
					: filtered,
			];
		})
		.join("\n")
		.trim();
}
