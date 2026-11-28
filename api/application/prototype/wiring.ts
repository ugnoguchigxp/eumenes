import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Config } from "../../infrastructure/config";
import { worksPreviewPort } from "../../infrastructure/works-preview";
import { createPrototypeService } from "../../domains/prototype";
import type { AppModule } from "../app-modules";
import type { Lifecycle } from "../lifecycle";
import { registerPrototypeRoutes } from "./routes";
import { prototypeExecution } from "./execution";
import { registerWorksImageRoutes, worksImages } from "./images";
import type { ImageService } from "../../domains/image";
import { readWorkspaceGuards } from "../../domains/kanban";
import type { SqliteStore } from "../../infrastructure/sqlite";

export function prototypeModule(
	config: Pick<Config, "origin" | "dbPath" | "env">,
	store?: SqliteStore,
) {
	const works = config.env.EUMENES_WORKS_DIR;
	const runtime = config.env.EUMENES_PROTOTYPE_HOME;
	const source = config.env.EUMENES_PROTOTYPE_SOURCE;
	if (!works || !runtime || config.dbPath === ":memory:") return undefined;
	const core = resolve(import.meta.dir, "../../..");
	const data = join(dirname(resolve(config.dbPath)), "works");
	const port = worksPreviewPort(config.env);
	mkdirSync(data, { recursive: true, mode: 0o700 });
	const service = createPrototypeService({
		core,
		data,
		works,
		runtime,
		parentOrigin: config.origin,
		previewPort: port,
		defaultVersion: config.env.EUMENES_PROTOTYPE_VERSION ?? "1.0",
		inUse:
			store &&
			((id) =>
				store.read(
					(db) => readWorkspaceGuards(db, `prototype:${id}`).length > 0,
				)),
	});
	const images = store && worksImages(store, service);
	let image: ImageService | undefined;
	const module: AppModule = {
		mount: (app) => {
			registerPrototypeRoutes(
				app,
				service,
				images && image
					? {
							removed: async (id, remove) => {
								const jobs = await images.store.write((db) => {
									remove();
									return image!.prototype.revokeInTransaction(db, id);
								});
								image!.prototype.flush(jobs);
							},
						}
					: undefined,
			);
			if (images && image) registerWorksImageRoutes(app, images, image);
		},
	};
	const lifecycle: Lifecycle = {
		name: "prototype_previews",
		close: () => service.close(),
	};
	const execution =
		Bun.which("claude") &&
		config.env.EUMENES_CLAUDE_WORK_RUNNER_AUTOSTART !== "0"
			? prototypeExecution(
					service,
					data,
					[core, dirname(resolve(config.dbPath))],
					source ? { source, home: runtime, works } : undefined,
				)
			: undefined;
	return {
		module,
		lifecycle,
		service,
		execution,
		images,
		attachImage(value: ImageService) {
			image = value;
		},
	};
}
