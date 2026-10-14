/** Runs before Vite's default error logger, which otherwise prints the callback query. */
export function redactGoogleOAuthProxyError(
	error: Error,
	request: { url?: string },
	response: object,
) {
	request.url = request.url?.split("?")[0];
	const incoming = (response as { req?: { url?: string } }).req;
	if (incoming) incoming.url = incoming.url?.split("?")[0];
	error.message = "google_oauth_proxy_failed";
	error.stack = undefined;
}
