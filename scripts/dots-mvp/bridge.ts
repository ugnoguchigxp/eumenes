import { join } from "node:path";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { privateDirectory, privateFile } from "./private-state";
import { equalSecret } from "./server";

// Synthetic-text acceptance only. The opaque URL binds one sandbox owner; it is not OAuth.
// This bridge exposes MCP only and never forwards the local control API.
export function startBridge(directory: string, upstream: string, port = 8798) {
	privateDirectory(directory);
	const capability = privateFile(join(directory, "bridge.token"), () =>
		Buffer.from(randomBytes(32).toString("base64url")),
	).toString();
	const admin = readFileSync(join(directory, "admin.token"), "utf8");
	const target = new URL("/mcp", upstream);
	if (
		target.protocol !== "http:" ||
		!["localhost", "127.0.0.1"].includes(target.hostname)
	)
		throw new Error("invalid_upstream");
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		maxRequestBodySize: 65536,
		idleTimeout: 150,
		async fetch(req) {
			const url = new URL(req.url);
			if (
				!equalSecret(url.pathname, `/mcp/${capability}`) ||
				url.search ||
				req.headers.has("origin")
			)
				return new Response("Not found", { status: 404 });
			if (!["GET", "POST", "DELETE"].includes(req.method))
				return new Response("Method not allowed", { status: 405 });
			const headers = new Headers(req.headers);
			headers.delete("host");
			headers.delete("cookie");
			headers.set("authorization", `Bearer ${admin}`);
			try {
				return await fetch(target, {
					method: req.method,
					headers,
					body: req.body,
					redirect: "error",
					signal: req.signal,
				});
			} catch {
				return new Response("MCP upstream unavailable", { status: 502 });
			}
		},
	});
	return {
		server,
		path: `/mcp/${capability}`,
		url: `http://127.0.0.1:${server.port}`,
	};
}
