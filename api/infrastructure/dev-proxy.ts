/** Dev proxy: attach the API credential only to requests from the SPA itself. */
export function shouldAuthorize(
	headers: { origin?: string; "sec-fetch-site"?: string },
	expectedOrigin: string,
): boolean {
	if (headers.origin !== undefined) return headers.origin === expectedOrigin;
	// Same-origin GET from the SPA may omit Origin; browsers always send Sec-Fetch-Site.
	return headers["sec-fetch-site"] === "same-origin";
}
