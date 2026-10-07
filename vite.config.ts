import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { resolveApiToken } from "./api/infrastructure/auth-config";
export default defineConfig(({ command, mode }) => {
	// Read backend settings on the dev server; never expose them through VITE_*.
	const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
	const token = command === "serve" ? resolveApiToken(env) : undefined;
	return {
		plugins: [react()],
		root: "web",
		server: {
			host: "127.0.0.1",
			proxy: {
				"/api": {
					target: env.EUMENES_PROXY_URL ?? "http://127.0.0.1:8787",
					configure(proxy) {
						proxy.on("proxyReq", (request, incoming) => {
							const expectedOrigin =
								env.EUMENES_ORIGIN ?? "http://127.0.0.1:5173";
							if (
								incoming.headers.origin &&
								incoming.headers.origin !== expectedOrigin
							)
								return;
							if (token) request.setHeader("Authorization", `Bearer ${token}`);
							request.setHeader("Origin", expectedOrigin);
						});
					},
				},
			},
		},
		build: { outDir: "../dist-web", emptyOutDir: true },
	};
});
