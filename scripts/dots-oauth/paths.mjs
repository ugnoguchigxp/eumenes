export function allowedAuthPath(path, method) {
	return (
		(method === "GET" &&
			[
				"/.well-known/openid-configuration",
				"/.well-known/oauth-authorization-server",
				"/jwks",
				"/auth",
			].includes(path)) ||
		(method === "GET" &&
			/^\/(auth|interaction)\/[a-zA-Z0-9_-]{1,150}$/.test(path)) ||
		(method === "POST" && ["/token", "/token/revocation"].includes(path))
	);
}
