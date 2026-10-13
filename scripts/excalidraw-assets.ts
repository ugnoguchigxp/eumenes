import { cpSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
/** The upstream editor is hosted locally, including fonts; no service origin is exposed. */
export function excalidrawAssets(): Plugin {
	const fontRoot = resolve(
		"node_modules/@excalidraw/excalidraw/dist/prod/fonts",
	);
	return {
		name: "eumenes-excalidraw-assets",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				if (!req.url?.startsWith("/excalidraw-assets/fonts/")) return next();
				const relative = req.url
					.slice("/excalidraw-assets/fonts/".length)
					.split("?")[0]!;
				const path = resolve(fontRoot, relative);
				if (
					!path.startsWith(`${fontRoot}/`) ||
					!path.endsWith(".woff2") ||
					!existsSync(path)
				) {
					res.statusCode = 404;
					res.end();
					return;
				}
				res.setHeader("Content-Type", "font/woff2");
				res.setHeader("Cache-Control", "public, max-age=3600");
				res.end(readFileSync(path));
			});
		},
		closeBundle() {
			cpSync(fontRoot, resolve("dist-web/excalidraw-assets/fonts"), {
				recursive: true,
			});
		},
	};
}
