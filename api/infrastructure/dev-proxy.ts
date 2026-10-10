/** Dev proxy: attach the API credential only to requests from the SPA itself. */
export function shouldAuthorize(
	headers: { origin?: string; "sec-fetch-site"?: string },
	expectedOrigin: string,
): boolean {
	if (headers.origin !== undefined) return headers.origin === expectedOrigin;
	// Same-origin GET from the SPA may omit Origin; browsers always send Sec-Fetch-Site.
	return headers["sec-fetch-site"] === "same-origin";
}

const loopback = new Set(["127.0.0.1", "localhost"]);

/** The canonical URL to redirect a loopback alias to, or null when already canonical. */
export function canonicalLoopbackRedirect(
	host: string | undefined,
	url: string,
	expectedOrigin: string,
): string | null {
	if (!host) return null;
	const expected = new URL(expectedOrigin);
	let actual: URL;
	try {
		actual = new URL(`http://${host}`);
	} catch {
		return null;
	}
	if (actual.host === expected.host) return null;
	if (!loopback.has(actual.hostname) || !loopback.has(expected.hostname))
		return null;
	if ((actual.port || "80") !== (expected.port || "80")) return null;
	// Only an absolute path: `//host` and `/\host` would resolve to another origin.
	if (!/^\/(?![/\\])/.test(url)) return null;
	return `${expected.origin}${url}`;
}
