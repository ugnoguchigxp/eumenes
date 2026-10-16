import { z } from "zod";

const sourceList = z.object({
	sources: z.array(
		z.object({ sourceId: z.string().optional(), url: z.string().optional() }),
	),
	claims: z.array(z.object({ sourceIds: z.array(z.string()) })).optional(),
});
const definition = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+["'(].*)?\s*$/;
const citationHead = /^\s*(?:ソース|出典|参考資料)\s*[:：]/;
const rawStops = new Set("<>\"'、。」』]\u0000");
const mark = "\u0000";

// Code is inert in the chat renderer. Preserve its text without counting any
// Markdown-looking URL inside it as a clickable citation.
const inlineSurface = (line: string) =>
	line.replace(/`[^`\n]+`/g, (code) => " ".repeat(code.length));

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

/** Keep only URLs granted by a host-verified result. */
export function researchCitations(
	text: string,
	projection?: string | null,
	options: { preserveLinkLabels?: boolean; requireSources?: boolean } = {},
) {
	const allowed = new Set<string>();
	const required = new Map<string, string>();
	const mentioned = new Set<string>();
	try {
		const parsed = sourceList.safeParse(JSON.parse(projection ?? "null"));
		if (parsed.success) {
			const cited = new Set(
				parsed.data.claims?.flatMap((claim) => claim.sourceIds),
			);
			for (const source of parsed.data.sources) {
				if (!source.url) continue;
				const url = normalize(source.url);
				if (url) {
					allowed.add(url);
					if (source.sourceId && cited.has(source.sourceId))
						required.set(url, new URL(source.url).href);
				}
			}
		}
	} catch {
		// Missing/failed reports grant no citations, including URLs from older turns.
	}
	const permitted = (url: string) => {
		const value = normalize(url);
		return value !== null && allowed.has(value);
	};
	const visibleUrl = (url: string, original: string) =>
		options.requireSources
			? `[${new URL(url).hostname}](<${new URL(url).href}>)`
			: original;
	let fenced = false;
	const answer = text
		.replaceAll(mark, "")
		.split(/\r?\n/)
		.flatMap((line) => {
			const inFence = fenced;
			if (fenced) {
				if (/^\s*```\s*$/.test(line)) fenced = false;
			} else if (/^\s*```[A-Za-z0-9_+-]{0,40}\s*$/.test(line)) fenced = true;
			const inert = inFence || fenced;
			const surface = inert ? "" : inlineSurface(line);
			const ref = definition.exec(line);
			if (ref) {
				if (!permitted(ref[1]!)) return [];
				// Definitions alone are invisible; restore a visible link below.
				return [line];
			}
			const citationLine = citationHead.test(line);
			const kept: string[] = [];
			let removed = 0;
			const keep = (token: string, url: string, visible: boolean) => {
				if (visible) mentioned.add(normalize(url)!);
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
							out += keep(
								options.requireSources
									? `[${label}](<${new URL(dest.url).href}>)`
									: line.slice(i, dest.end),
								dest.url,
								!!surface[i]?.trim(),
							);
						else {
							removed++;
							out +=
								options.preserveLinkLabels === false
									? ""
									: image || !citationLine
										? label
										: "";
						}
						i = dest.end;
						continue;
					}
				}
				const auto = /^<(https?:\/\/[^>\s]+)>/.exec(line.slice(i));
				if (auto) {
					if (permitted(auto[1]!))
						out += keep(
							visibleUrl(auto[1]!, auto[0]),
							auto[1]!,
							!!surface[i]?.trim(),
						);
					else removed++;
					i += auto[0].length;
					continue;
				}
				out += line[i];
				i++;
			}
			// Raw URLs, including those that were only a label of a refused link.
			const rawSurface = inert ? "" : inlineSurface(out);
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
					if (rawSurface[i]?.trim()) mentioned.add(normalize(url)!);
					kept.push(visibleUrl(url, url));
					filtered += `${mark}${kept.length - 1}${mark}`;
				} else removed++;
				i = Math.max(end, i + 1);
			}
			filtered = filtered.replace(
				new RegExp(`${mark}(\\d+)${mark}`, "g"),
				(_, n: string) => kept[Number(n)]!,
			);
			if (citationLine && removed > 0 && kept.length === 0) return [];
			if (
				options.preserveLinkLabels === false &&
				removed > 0 &&
				kept.length === 0 &&
				/^.{1,60}[:：]\s*$/.test(filtered.trim())
			)
				return [];
			return [
				citationLine
					? filtered.replace(/([:：])[\s、,]+/g, "$1").replace(/[\s、,]+$/, "")
					: filtered,
			];
		})
		.join("\n")
		.trim();
	if (!options.requireSources || !answer) return answer;
	// This is URL/receipt integrity, not a semantic choice of facts or sources:
	// only sourceIds already cited by the accepted report can be restored.
	const missing = [...required]
		.filter(([key]) => !mentioned.has(key))
		.map(([, url]) => `[${new URL(url).hostname}](<${url}>)`);
	const complete =
		answer +
		(missing.length
			? (fenced ? "\n```" : "") + "\n\n出典：" + missing.join("、")
			: "");
	if (complete.length > 65536) throw new Error("chat_output_too_large");
	return complete;
}
