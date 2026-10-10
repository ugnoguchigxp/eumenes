import { resolve } from "node:path";
import { createClient } from "../client";
import { readApiToken } from "../api/infrastructure/auth-config";
/** A narrow reverse-proxy upstream for a TLS terminator. It never forwards the product control API. */
export function startDotsGateway(input: {
	upstream: string;
	connectionRef: string;
	publicResource: string;
	port?: number;
}) {
	const target = new URL(input.upstream),
		resource = new URL(input.publicResource),
		path = `/mcp/dots/${input.connectionRef}`,
		metadata = `/.well-known/oauth-protected-resource${path}`;
	if (
		!/^[a-zA-Z0-9_.:-]{1,160}$/.test(input.connectionRef) ||
		target.protocol !== "http:" ||
		!["127.0.0.1", "localhost"].includes(target.hostname) ||
		target.username ||
		target.password ||
		resource.protocol !== "https:" ||
		resource.pathname !== path ||
		resource.username ||
		resource.password ||
		resource.search ||
		resource.hash
	)
		throw new Error("invalid_dots_gateway");
	return Bun.serve({
		hostname: "127.0.0.1",
		port: input.port ?? 8799,
		maxRequestBodySize: 131072,
		idleTimeout: 60,
		async fetch(req) {
			const u = new URL(req.url);
			if (u.search || ![path, metadata].includes(u.pathname))
				return new Response("Not found", { status: 404 });
			if (
				(u.pathname === metadata && req.method !== "GET") ||
				(u.pathname === path && !["GET", "POST", "DELETE"].includes(req.method))
			)
				return new Response("Method not allowed", { status: 405 });
			if (
				req.headers.has("origin") &&
				req.headers.get("origin") !== resource.origin
			)
				return new Response("Forbidden", { status: 403 });
			const headers = new Headers(req.headers);
			headers.delete("host");
			headers.delete("cookie");
			headers.delete("origin");
			headers.set("x-forwarded-proto", "https"); // Always marks a proxy: local-only credentials cannot become public credentials.
			try {
				return await fetch(new URL(u.pathname, target), {
					method: req.method,
					headers,
					body: req.body,
					redirect: "error",
					signal: AbortSignal.any([req.signal, AbortSignal.timeout(30000)]),
				});
			} catch {
				return new Response("Upstream unavailable", { status: 502 });
			}
		},
	});
}
if (import.meta.main) {
	const connectionRef = process.argv[2];
	if (!connectionRef) throw new Error("connection_ref_required");
	const upstream = process.env.EUMENES_URL ?? "http://127.0.0.1:8787",
		client = createClient(
			upstream,
			readApiToken(
				process.env,
				resolve(import.meta.dir, "../data/eumenes.sqlite3"),
			),
		);
	const config = await client.dotsConfiguration(),
		c = config.connections.find((c) => c.id === connectionRef);
	if (!c?.enabled || !c.oauth) throw new Error("dots_oauth_required");
	const server = startDotsGateway({
		upstream,
		connectionRef,
		publicResource: c.oauth.resource,
		port: Number(process.env.EUMENES_DOTS_GATEWAY_PORT ?? 8799),
	});
	process.stdout.write(
		`dots gateway listening on loopback port ${server.port}\n`,
	);
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.on(signal, () => server.stop(true));
}
