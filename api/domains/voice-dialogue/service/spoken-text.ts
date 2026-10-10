/** Keep citations in the displayed answer; speak prose and inline link labels. */
export function spokenText(text: string): string {
	return text
		.split(/\r?\n/)
		.filter((line) => {
			const citation = line.match(/^\s*(?:ソース|出典|参考資料)\s*[:：](.*)$/);
			if (!citation || !citation[1]!.includes("](")) return true;
			// Keep any prose attached to a citation instead of discarding facts.
			const remainder = citation[1]!.replace(
				/\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/g,
				"",
			);
			return !/^[\s、,。・/]*$/.test(remainder);
		})
		.join("\n")
		.replace(/\[([^\]\n]+)\]\(https?:\/\/[^)\s]+\)/g, "$1")
		.trim();
}
