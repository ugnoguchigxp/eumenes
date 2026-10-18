const URL_CHARS = 160;

export const clip = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max)}…` : text;

/** Query and fragment can carry secrets; the model sees where a tab is, not what it was sent. */
export function placeOf(raw: string) {
	try {
		const url = new URL(raw);
		return clip(`${url.origin}${url.pathname}`, URL_CHARS);
	} catch {
		return "";
	}
}

/** The origin of an http(s) page, or null. */
export function originOf(raw: string | null) {
	if (!raw) return null;
	try {
		const url = new URL(raw);
		return url.protocol === "http:" || url.protocol === "https:"
			? url.origin
			: null;
	} catch {
		return null;
	}
}

/** Width, case, spacing and the separators people add to numbers do not change what was written. */
export const squash = (text: string) =>
	text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\s\-ー‐–—,，、/／]+/g, "");

/** A run this long, shared with a page and not with the request, is not the user's own value. */
const PAGE_RUN = 8;
const SEEN_ENTRIES = 6;
const SEEN_CHARS = 200_000;

/** Page-derived text a task has read (normalised); older entries go first when it grows past its bounds. */
export function addSeen(seen: readonly string[], ...texts: string[]) {
	const next = [...seen];
	for (const text of texts) {
		const squashed = squash(text);
		if (squashed) next.push(squashed);
	}
	while (
		next.length > SEEN_ENTRIES ||
		(next.length > 1 && next.reduce((n, s) => n + s.length, 0) > SEEN_CHARS)
	)
		next.shift();
	return next;
}

/**
 * Whether the value carries a run of at least eight normalised characters that a page showed and the user's
 * request did not contain. Such a value comes from the page, so the user must allow it before it is typed.
 */
export function fromPage(
	value: string,
	request: string,
	seen: readonly string[],
) {
	const v = squash(value);
	if (v.length < PAGE_RUN || !seen.length) return false;
	const asked = squash(request);
	const read = seen.join("\0");
	for (let i = 0; i + PAGE_RUN <= v.length; i++) {
		const run = v.slice(i, i + PAGE_RUN);
		if (!asked.includes(run) && read.includes(run)) return true;
	}
	return false;
}
