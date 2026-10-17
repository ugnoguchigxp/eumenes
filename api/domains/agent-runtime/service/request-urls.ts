/** Supplement omitted model metadata with bounded, explicit URLs in the current request. */
export function requestUrls(question: string, supplied?: string[]) {
	const urls = [...(supplied ?? [])];
	for (const raw of question.match(/https?:\/\/[^\s<>"'`）］」』】、。]+/gu) ??
		[]) {
		const url = raw.replace(/[)\],;）］」』】]+$/u, "");
		try {
			const parsed = new URL(url);
			if (!["http:", "https:"].includes(parsed.protocol)) continue;
			if (!urls.includes(parsed.href)) urls.push(parsed.href);
		} catch {
			/* Leave malformed references outside the tool scope. */
		}
		if (urls.length >= 3) break;
	}
	return urls.length ? urls.slice(0, 3) : undefined;
}
