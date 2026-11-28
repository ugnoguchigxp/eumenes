import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { readStable } from "./runtime/project";

type Manifest = {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	scripts?: Record<string, string>;
};

function manifest(root: string): Manifest {
	const file = join(root, "package.json");
	if (!existsSync(file)) return {};
	const stat = lstatSync(file);
	if (!stat.isFile() || stat.size > 128 * 1024 || realpathSync(file) !== file)
		throw new Error("prototype_trial_manifest_invalid");
	const input = JSON.parse(readStable(file, stat, 128 * 1024).toString("utf8"));
	if (!input || Array.isArray(input) || typeof input !== "object")
		throw new Error("prototype_trial_manifest_invalid");
	return input as Manifest;
}

export function trialInventory(
	project: string,
	release: string,
	entry: string,
) {
	const given = manifest(project);
	const runtime = manifest(release);
	const shared = { ...runtime.devDependencies, ...runtime.dependencies };
	const requested = Object.entries({
		...given.devDependencies,
		...given.dependencies,
	}).filter(([, range]) => typeof range === "string");
	return {
		missing: requested
			.filter(([name]) => !Object.hasOwn(shared, name))
			.map(([name]) => name)
			.sort(),
		versionDifferences: requested.flatMap(([name, declared]) => {
			const pinned = shared[name];
			return typeof pinned === "string" && declared !== pinned
				? [{ name, declared, shared: pinned }]
				: [];
		}),
		originalCommands: Object.keys(given.scripts ?? {})
			.filter((name) =>
				/(^|:)(dev|start|build|typecheck|preview|demo)$/.test(name),
			)
			.sort(),
		configuration: [
			"vite.config.ts",
			"vite.config.js",
			"postcss.config.js",
			"next.config.ts",
			"bunfig.toml",
			"tsconfig.json",
			".env.example",
		].filter((name) => existsSync(join(project, name))),
		unsupported: ["index.html", "server.ts", "server.js"].filter((name) =>
			existsSync(join(project, dirname(entry), name)),
		),
	};
}
