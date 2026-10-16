/** URLs are display data, not spoken prose; this also removes URL-shaped link labels. */
const webUrl = /https?:\/\/[^\s<>"'、。！？\]）)]+/gi;
const host =
	/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(?::\d+)?(?:\/[^\s<>"'、。！？\]）)]*)?/gi;
const inlineLink = /\[([^\]\n]+)\]\(<?https?:\/\/[^\n]*?>?\)/g;
const citation = /^\s*(?:ソース|出典|参考資料)\s*[:：](.*)$/;
const withoutUrls = (text: string) =>
	text.replace(webUrl, "").replace(host, "");

/** Keep citations in the displayed answer; speak prose and descriptive inline link labels. */
export function spokenText(text: string): string {
	return text
		.split(/\r?\n/)
		.map((line) => {
			const source = citation.exec(line);
			if (source && /https?:\/\/|\]\(/i.test(source[1]!)) {
				// Keep facts appended to a source line, but neither its links nor its heading.
				return withoutUrls(source[1]!.replace(inlineLink, "")).replace(
					/^[\s、,。・/()[\]<>:：-]+/,
					"",
				);
			}
			return withoutUrls(line.replace(inlineLink, "$1"));
		})
		.filter((line) => line.trim())
		.join("\n")
		.trim();
}

/** A URL or Markdown label must be complete before rendering its buffered suffix. */
export function spokenPrefix(text: string, final = false): string {
	if (!final) {
		const unfinished = [
			/\[[^\]\n]*(?:\](?:\([^()\n]*)?)?$/,
			/https?:\/\/[^\s<>"'、。！？\]）)]*$/i,
			/\b(?:[a-z0-9][a-z0-9-]*\.)+[a-z0-9-]*(?::\d*)?(?:\/[^\s<>"'、。！？\]）)]*)?$/i,
		].flatMap((pattern) => {
			const match = pattern.exec(text);
			return match ? [match.index] : [];
		});
		if (unfinished.length) text = text.slice(0, Math.min(...unfinished));
	}
	return spokenText(text);
}
