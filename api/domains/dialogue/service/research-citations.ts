import { z } from "zod";

const sourceList = z.object({
	sources: z.array(z.object({ url: z.string() })),
});
const link = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** A research answer can link only to URLs in its host-verified report. */
export function researchCitations(text: string, projection?: string | null) {
	let urls = new Set<string>();
	try {
		const parsed = sourceList.safeParse(JSON.parse(projection ?? "null"));
		if (parsed.success)
			urls = new Set(parsed.data.sources.map((source) => source.url));
	} catch {
		// Missing/failed reports grant no citations, including URLs from older turns.
	}
	return text
		.split(/\r?\n/)
		.flatMap((line) => {
			const citationLine = /^\s*(?:ソース|出典|参考資料)\s*[:：]/.test(line);
			const filtered = line.replace(
				link,
				(token, label: string, url: string) =>
					urls.has(url) ? token : citationLine ? "" : label,
			);
			if (
				/^\s*(?:ソース|出典|参考資料)\s*[:：]/.test(line) &&
				line.includes("](") &&
				![...filtered.matchAll(link)].length
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
}
