import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({
	plugins: [react()],
	root: "web",
	server: {
		host: "127.0.0.1",
		proxy: { "/api": process.env.EUMENES_PROXY_URL ?? "http://127.0.0.1:8787" },
	},
	build: { outDir: "../dist-web", emptyOutDir: true },
});
