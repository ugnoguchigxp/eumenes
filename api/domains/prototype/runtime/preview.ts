import { lstatSync, realpathSync } from "node:fs";
import { extname, join } from "node:path";
import { relativePath } from "./project";

export const loopback = "127.0.0.1";
const validId = /^[a-f0-9-]{36}$/;
const types: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".gltf": "model/gltf+json",
	".glb": "model/gltf-binary",
	".bin": "application/octet-stream",
	".svg": "image/svg+xml",
	".png": "image/png",
	".webp": "image/webp",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
};
const previewFile = (name: string) =>
	relativePath(name) &&
	(["index.html", "app.js", "app.css"].includes(name) ||
		/^(assets|samples|bundle)\//.test(name));

export function loopbackOrigin(value: string) {
	const url = new URL(value);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		!["localhost", loopback].includes(url.hostname) ||
		url.origin !== value
	)
		throw new Error("prototype_origin_unsupported");
	return url.origin;
}

export function previewListener(port: number, parent?: string) {
	const views = new Map<string, { id: string; output: string }>();
	const ancestry = parent ? loopbackOrigin(parent) : "'none'";
	const csp = [
		"default-src 'none'",
		"script-src 'self'",
		"style-src 'self'",
		"connect-src 'self'",
		"img-src 'self' blob:",
		"font-src 'self'",
		"worker-src 'none'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors " + ancestry,
	].join("; ");
	const server = Bun.serve({
		hostname: loopback,
		port,
		fetch(request, actual) {
			if (actual.requestIP(request)?.address !== loopback)
				return new Response(null, { status: 403 });
			const url = new URL(request.url);
			if (
				url.host !== request.headers.get("host") ||
				url.port !== String(actual.port)
			)
				return new Response(null, { status: 421 });
			if (!["GET", "HEAD"].includes(request.method))
				return new Response(null, { status: 405 });
			const route = /^\/v\/([a-f0-9-]{36})\/(.*)$/.exec(url.pathname);
			const view = route && views.get(route[1]!);
			if (!view || url.hostname !== "p-" + view.id + ".localhost")
				return new Response(null, { status: 404 });
			let name: string;
			try {
				name = decodeURIComponent(route[2]!) || "index.html";
			} catch {
				return new Response(null, { status: 404 });
			}
			const contentType = types[extname(name)];
			if (
				!previewFile(name) ||
				!contentType ||
				(name !== "index.html" && extname(name) === ".html")
			)
				return new Response(null, { status: 404 });
			const file = join(view.output, name);
			try {
				if (realpathSync(file) !== file || !lstatSync(file).isFile())
					return new Response(null, { status: 404 });
			} catch {
				return new Response(null, { status: 404 });
			}
			return new Response(request.method === "HEAD" ? null : Bun.file(file), {
				headers: {
					"Content-Type": contentType,
					"Content-Security-Policy": csp,
					"X-Content-Type-Options": "nosniff",
					"Cache-Control": "no-store",
					"Referrer-Policy": "no-referrer",
					"Permissions-Policy":
						"autoplay=(), microphone=(), camera=(), display-capture=()",
				},
			});
		},
	});
	return {
		add(id: string, output: string) {
			if (!validId.test(id)) throw new Error("prototype_id_invalid");
			const key = crypto.randomUUID();
			views.set(key, { id, output });
			return {
				url: "http://p-" + id + ".localhost:" + server.port + "/v/" + key + "/",
				release: () => {
					views.delete(key);
				},
			};
		},
		port: server.port!,
		close: () => server.stop(true),
	};
}
