import { expect, test } from "bun:test";
import { redactGoogleOAuthProxyError } from "../proxy-errors";
test("proxy failure logging strips callback credentials without changing the route", () => {
	const request = {
		url: "/oauth/google/callback?code=private-code&state=private-state",
	};
	const response = { req: { ...request } };
	const error = new Error("Proxy failed at " + request.url);
	redactGoogleOAuthProxyError(error, request, response);
	expect(request.url).toBe("/oauth/google/callback");
	expect(response.req.url).toBe("/oauth/google/callback");
	expect(error.message).toBe("google_oauth_proxy_failed");
	expect(error.stack).toBeUndefined();
	expect(JSON.stringify({ request, response, error })).not.toContain(
		"private-",
	);
});
