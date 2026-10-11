import { startDotsGateway } from "../dots-gateway";
import { readApiToken } from "../../api/infrastructure/auth-config";
import { createClient } from "../../client";
import { allowedAuthPath } from "./paths.mjs";

const ref = process.argv[2];
if (!ref) throw new Error("connection_ref_required");
const api = "http://127.0.0.1:8787";
const config = await createClient(
	api,
	readApiToken(process.env),
).dotsConfiguration();
const connection = config.connections.find((c) => c.id === ref);
if (!connection?.enabled || !connection.oauth)
	throw new Error("dots_oauth_required");
const origin = new URL(connection.oauth.resource).origin;
if (
	connection.oauth.issuer !== origin ||
	connection.oauth.jwksUrl !== `${origin}/jwks`
)
	throw new Error("trial_issuer_mismatch");
const gateway = startDotsGateway({
	upstream: api,
	connectionRef: ref,
	publicResource: connection.oauth.resource,
});
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 8801,
	maxRequestBodySize: 131072,
	idleTimeout: 60,
	async fetch(req) {
		const url = new URL(req.url);
		const metadata = `/.well-known/oauth-protected-resource/mcp/dots/${ref}`;
		const mcp = [`/mcp/dots/${ref}`, metadata].includes(url.pathname);
		if (
			(!mcp && !allowedAuthPath(url.pathname, req.method)) ||
			(mcp && url.search)
		)
			return new Response("Not found", { status: 404 });
		const browserOrigin = req.headers.get("origin");
		if (browserOrigin && browserOrigin !== origin)
			return new Response("Forbidden", { status: 403 });
		const headers = new Headers(req.headers);
		headers.delete("host");
		headers.delete("forwarded");
		headers.delete("x-forwarded-for");
		headers.set("x-forwarded-host", new URL(origin).host);
		headers.set("x-forwarded-proto", "https");
		if (mcp) headers.delete("cookie");
		try {
			return await fetch(
				`http://127.0.0.1:${mcp ? gateway.port : 8800}${url.pathname}${url.search}`,
				{
					method: req.method,
					headers,
					body: req.body,
					redirect: "manual",
					signal: AbortSignal.any([req.signal, AbortSignal.timeout(30000)]),
				},
			);
		} catch {
			return new Response("Upstream unavailable", { status: 502 });
		}
	},
});
process.stdout.write(
	`Trial public upstream listening on loopback ${server.port}\n`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => {
		server.stop(true);
		gateway.stop(true);
	});
