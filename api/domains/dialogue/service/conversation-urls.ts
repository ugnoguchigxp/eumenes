/** Only URLs actually present in the conversation may authorize a direct read. */
export function conversationUrls(turns: string[]) {
	const result: string[] = [];
	for (const text of [...turns].reverse())
		for (const raw of text.match(/https?:\/\/[^\s<>"'\u0080-\uFFFF]+/gu) ??
			[]) {
			const url = raw.replace(/[)\],;]+$/u, "");
			try {
				const parsed = new URL(url);
				if (
					!["http:", "https:"].includes(parsed.protocol) ||
					parsed.username ||
					parsed.password
				)
					continue;
				if (!result.includes(url)) result.push(url);
			} catch {}
			if (result.length >= 3) return result;
		}
	return result;
}
