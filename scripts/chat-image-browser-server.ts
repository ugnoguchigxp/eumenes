import { resolve, sep } from "node:path";
const root = resolve(process.env.EUMENES_WEB_DIR!);
const api = new URL(process.env.EUMENES_PROXY_URL!);
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.EUMENES_PORT),
	idleTimeout: 60,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname.startsWith("/api/")) {
			const headers = new Headers(req.headers);
			headers.set(
				"Authorization",
				"Bearer fixture-token-for-toolchain-browser",
			);
			headers.delete("host");
			return fetch(new URL(url.pathname + url.search, api), {
				method: req.method,
				headers,
				body:
					req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
				signal: req.signal,
				redirect: "error",
			});
		}
		const path = resolve(root, "." + decodeURIComponent(url.pathname));
		if (path !== root && !path.startsWith(root + sep))
			return new Response(null, { status: 404 });
		const file = Bun.file(path);
		return new Response(
			(await file.exists()) ? file : Bun.file(resolve(root, "index.html")),
		);
	},
});
process.on("SIGTERM", () => {
	server.stop(true);
	process.exit(0);
});
