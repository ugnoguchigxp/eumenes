/**
 * A URL reduced to what identifies the page: origin and path. Query strings and fragments carry tokens,
 * search terms and ids, so the ledgers never keep them. Non-web schemes keep the scheme and host only.
 */
export function originPath(raw: string): string {
	try {
		const url = new URL(raw);
		if (url.protocol === "http:" || url.protocol === "https:")
			return `${url.origin}${url.pathname}`;
		return `${url.protocol}${url.host ? `//${url.host}` : ""}`;
	} catch {
		return "";
	}
}
