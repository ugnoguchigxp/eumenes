import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { resolve } from "node:path";
import { resolveApiToken } from "./api/infrastructure/auth-config";
import { shouldAuthorize } from "./api/infrastructure/dev-proxy";

const first = (value: string | string[] | undefined) =>
	Array.isArray(value) ? value[0] : value;

export default defineConfig(({ command, mode }) => {
	// Read backend settings on the dev server; never expose them through VITE_*.
	const env = { ...loadEnv(mode, process.cwd(), "EUMENES_"), ...process.env };
	const token = command === "serve" ? resolveApiToken(env) : undefined;
	return {
		plugins: [
			react(),
			{
				// Frame-ancestors only: a full CSP would break HMR and the React preamble.
				name: "eumenes-security-headers",
				configureServer(server) {
					server.middlewares.use((_req, res, next) => {
						res.setHeader("X-Frame-Options", "DENY");
						res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
						next();
					});
				},
			},
		],
		root: "web",
		// Fixture servers must not replace the running developer server's dependencies.
		cacheDir:
			env.EUMENES_VITE_CACHE_DIR ?? resolve("node_modules/.vite/development"),
		// The lazy showcase needs this on first open, without a mid-session dependency rebuild.
		optimizeDeps: { include: ["three", "@openuidev/react-lang"] },
		server: {
			host: "127.0.0.1",
			cors: false,
			fs: {
				strict: true,
				allow: [
					resolve("web"),
					resolve("client"),
					resolve("packages"),
					resolve("api"),
					resolve("node_modules"),
				],
				deny: [
					"**/.git/**",
					".env",
					".env.*",
					"*.{crt,pem,key}",
					// Absolute project paths: a bare `**/data/**` would also match any
					// parent directory named data (e.g. /data/work/eumenes).
					`${resolve("data")}/**`,
					"**/*.sqlite3*",
					`${resolve("verification-reports")}/**`,
				],
			},
			proxy: {
				"/api": {
					target: env.EUMENES_PROXY_URL ?? "http://127.0.0.1:8787",
					configure(proxy) {
						proxy.on("proxyReq", (request, incoming) => {
							const expectedOrigin =
								env.EUMENES_ORIGIN ?? "http://127.0.0.1:5173";
							const authorized = shouldAuthorize(
								{
									origin: first(incoming.headers.origin),
									"sec-fetch-site": first(incoming.headers["sec-fetch-site"]),
								},
								expectedOrigin,
							);
							if (!authorized) {
								request.removeHeader("authorization");
								return;
							}
							if (token) request.setHeader("Authorization", `Bearer ${token}`);
							request.setHeader("Origin", expectedOrigin);
						});
					},
				},
			},
		},
		build: {
			outDir: "../dist-web",
			emptyOutDir: true,
			rollupOptions: {
				output: {
					manualChunks(id) {
						if (!id.includes("node_modules")) return undefined;
						if (/node_modules\/(react|react-dom|scheduler)\//.test(id))
							return "react";
						if (id.includes("/@tanstack/")) return "query";
						if (/node_modules\/zod\//.test(id)) return "zod";
						if (id.includes("/@radix-ui/")) return "radix";
						return undefined;
					},
				},
			},
		},
	};
});
