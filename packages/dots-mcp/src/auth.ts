import {
	createRemoteJWKSet,
	jwtVerify,
	customFetch,
	type JWTVerifyGetKey,
} from "jose";
import { publicHttpsGet } from "./webhook";
export const scopes = ["dots:read", "dots:report", "dots:events"];
export type OAuth = {
	issuer: string;
	jwksUrl: string;
	resource: string;
	subject: string;
};
const resolvers = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function verifyAccess(
	config: OAuth,
	token: string,
	keys?: JWTVerifyGetKey,
) {
	const key = `${config.issuer}:${config.jwksUrl}`;
	let jwks = keys ?? resolvers.get(key);
	if (!jwks) {
		if (resolvers.size >= 16) resolvers.delete(resolvers.keys().next().value!);
		const remote = createRemoteJWKSet(new URL(config.jwksUrl), {
			[customFetch]: async (url, init) => {
				const signal = AbortSignal.any([
					AbortSignal.timeout(5000),
					...(init?.signal ? [init.signal] : []),
				]);
				const r = await publicHttpsGet(String(url), signal);
				return new Response(r.body, {
					status: r.status,
					headers: { "content-type": "application/json" },
				});
			},
		});
		resolvers.set(key, remote);
		jwks = remote;
	}
	const { payload } = await jwtVerify(token, jwks, {
		issuer: config.issuer,
		audience: config.resource,
		algorithms: ["RS256", "ES256", "EdDSA"],
		requiredClaims: ["sub", "exp", "iat"],
		maxTokenAge: "1h",
	});
	if (
		payload.sub !== config.subject ||
		typeof payload.scope !== "string" ||
		!scopes.every((s) => payload.scope!.toString().split(" ").includes(s))
	)
		throw new Error("dots_permission_denied");
	return {
		subject: payload.sub,
		expiresAt: Math.min(payload.exp!, payload.iat! + 3600) * 1000,
	};
}
