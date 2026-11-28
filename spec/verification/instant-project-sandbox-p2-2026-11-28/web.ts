import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../../../api/application/app";
import { registerPrototypeRoutes } from "../../../api/application/prototype/routes";
import type { PrototypeService } from "../../../api/domains/prototype";
import { worksFrameSource } from "../../../api/infrastructure/works-preview";

type WorksWeb = {
	core: string;
	temp: string;
	origin: string;
	previewPort: number;
	works: PrototypeService;
	mount?(app: Hono): void;
};

export async function buildWorksWeb(input: Pick<WorksWeb,"core"|"temp">) {
	const [{default:react},{build}]=await Promise.all([import("@vitejs/plugin-react"),import("vite")]);
	const dir = join(input.temp, "web-build");
	await build({
		configFile: false,
		root: join(input.core, "web"),
		envDir: input.temp,
		publicDir: false,
		cacheDir: join(input.temp, "vite-cache"),
		logLevel: "error",
		plugins: [react()],
		resolve: { dedupe: ["zod"] },
		build: {
			outDir: dir,
			rollupOptions: {
				input: join(import.meta.dir, "../instant-project-sandbox-p1-2026-11-28/web-entry.tsx"),
				output: { entryFileNames: "fixture.js" },
			},
		},
	});
	return dir;
}

export async function prepareWorksWeb(input: WorksWeb) {
	return serveWorksWeb(input, await buildWorksWeb(input));
}

export function serveWorksWeb(input: WorksWeb, dir: string) {
	const token = "fixture-token-for-toolchain-browser";
	const web = new Map<string, Response>();
	for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const path = join(entry.parentPath, entry.name);
		const file = Bun.file(path);
		web.set(path.slice(dir.length), new Response(file, { headers: { "Content-Type": file.type } }));
	}
	const css = [...web.keys()].filter((path) => path.endsWith(".css"))
		.map((path) => '<link rel="stylesheet" href="' + path + '">').join("");
	web.set("/", new Response(
		'<!doctype html><meta charset="utf-8"><meta name="fixture-token" content="' + token + '">' +
			css + '<div id="root"></div><script type="module" src="/fixture.js"></script>',
		{ headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'self' " + worksFrameSource(input.previewPort),
		} },
	));
	const api = createApp({ token, origin: input.origin, modules: [{ mount(app) {
		registerPrototypeRoutes(app, input.works);
		input.mount?.(app);
		app.get("/api/status", (c) => c.json({ service: "eumenes", phase: "ready" }));
	} }] });
	return (request: Request) => {
		const path = new URL(request.url).pathname;
		return path.startsWith("/api/prototypes") || path === "/api/status" || (input.mount && path.startsWith("/api/images/"))
			? api.fetch(request)
			: web.get(path)?.clone();
	};
}
