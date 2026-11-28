import {
	appendFileSync,
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	isInside,
	copyPublicAssets,
	writeSnapshot,
	type Mode,
	type Snapshot,
} from "./project";
import { buildInWorker } from "./worker.js";

export type BuildResult = { built: boolean; diagnostics: string[] };
type Exports = Record<string, [string, string]>;

function mapping(runtime: string, mode: Mode): Exports {
	const links = JSON.parse(
		readFileSync(join(runtime, "resolution.json"), "utf8"),
	) as Exports;
	const adapter =
		mode === "host" ? "host-adapter.tsx" : "standalone-adapter.tsx";
	links["eumenes-prototype/app"] = [adapter, adapter];
	return Object.fromEntries(
		Object.entries(links).map(([name, files]) => [
			name,
			files.map((file) => {
				if (
					typeof file !== "string" ||
					!isInside(runtime, resolve(runtime, file))
				)
					throw new Error("prototype_environment_invalid");
				const path = realpathSync(join(runtime, file));
				if (!isInside(runtime, path) || !lstatSync(path).isFile())
					throw new Error("prototype_environment_invalid");
				return path;
			}),
		]),
	) as Exports;
}

function typeConfig(runtime: string, links: Exports) {
	return {
		compilerOptions: {
			target: "ES2022",
			module: "ESNext",
			moduleResolution: "Bundler",
			jsx: "react-jsx",
			jsxImportSource: "react",
			strict: true,
			noEmit: true,
			skipLibCheck: true,
			types: [],
			lib: ["ES2022", "DOM", "DOM.Iterable"],
			paths: Object.fromEntries(
				Object.entries(links).map(([name, [, types]]) => [name, [types]]),
			),
		},
		files: [join(runtime, "styles.d.ts")],
	};
}

export function configureEditor(project: string, runtime: string, mode: Mode) {
	const directory = join(project, ".eumenes");
	try {
		mkdirSync(directory, { mode: 0o700 });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
	}
	if (
		!lstatSync(directory).isDirectory() ||
		realpathSync(directory) !== directory
	)
		throw new Error("prototype_generated_path_invalid");
	const scratch = mkdtempSync(join(directory, "settings-"));
	try {
		const file = join(scratch, "tsconfig.json");
		writeFileSync(
			file,
			JSON.stringify(typeConfig(runtime, mapping(runtime, mode)), null, 2),
		);
		renameSync(file, join(directory, "tsconfig.generated.json"));
	} finally {
		rmSync(scratch, { recursive: true });
	}
}

export async function runBuild(input: {
	runtime: string;
	snapshot: Snapshot;
	target: string;
	mode: Mode;
	work: string;
	build: boolean;
	strict: boolean;
	typecheck: boolean;
	signal?: AbortSignal;
	insideCheckSandbox?: boolean;
}): Promise<BuildResult> {
	if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))
		throw new Error("prototype_platform_unsupported");
	mkdirSync(input.work, { recursive: true, mode: 0o700 });
	const task = realpathSync(mkdtempSync(join(input.work, "build-")));
	const stage = join(task, "input");
	const output = join(task, "output");
	const settings = join(task, "settings");
	const bun = realpathSync(process.execPath);
	try {
		for (const path of [stage, output, settings])
			mkdirSync(path, { mode: 0o700 });
		writeSnapshot(input.snapshot, stage);
		const links = mapping(input.runtime, input.mode);
		const typePath = join(settings, "typecheck.json");
		writeFileSync(typePath, JSON.stringify(typeConfig(input.runtime, links)));
		writeFileSync(
			join(settings, "build.json"),
			JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }),
		);
		writeFileSync(join(settings, "bunfig.toml"), "");
		const configPath = join(settings, "request.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				stage,
				output,
				entry: input.snapshot.project.entry,
				typeConfig: typePath,
				exported: Object.fromEntries(
					Object.entries(links).map(([name, [script]]) => [name, script]),
				),
				sourcelist: [...input.snapshot.files.keys()].filter((path) =>
					/\.tsx?$/.test(path),
				),
				build: input.build,
				typecheck: input.typecheck,
				strict: input.strict,
			}),
		);
		const literal = (path: string) => "(literal " + JSON.stringify(path) + ")";
		const subpath = (path: string) => "(subpath " + JSON.stringify(path) + ")";
		const profile = [
			"(version 1)",
			"(allow default)",
			"(deny file-read-data)",
			"(allow file-read-data " +
				["/", task, bun].map(literal).join(" ") +
				" " +
				[
					"/System",
					"/usr/lib",
					"/private/preboot",
					input.runtime,
					stage,
					settings,
					output,
				]
					.map(subpath)
					.join(" ") +
				")",
			"(deny file-write*)",
			"(allow file-write* " + subpath(output) + ")",
			"(deny network*)",
			"(deny process-exec)",
			"(allow process-exec " + literal(bun) + ")",
		].join(" ");
		let result: BuildResult;
		if (input.insideCheckSandbox) {
			result = await buildInWorker(configPath);
		} else {
			const child = Bun.spawn(
				[
					"/usr/bin/sandbox-exec",
					"-p",
					profile,
					bun,
					"--no-env-file",
					"--no-install",
					"--no-macros",
					"--config=" + join(settings, "bunfig.toml"),
					join(input.runtime, "worker.js"),
					configPath,
				],
				{
					cwd: settings,
					env: { PATH: "/usr/bin:/bin", HOME: settings, TMPDIR: output },
					stdout: "pipe",
					stderr: "ignore",
					signal: input.signal
						? AbortSignal.any([input.signal, AbortSignal.timeout(40_000)])
						: AbortSignal.timeout(40_000),
				},
			);
			const [stdout, exit] = await Promise.all([
				new Response(child.stdout).text(),
				child.exited,
			]);
			if (exit !== 0) throw new Error("prototype_builder_failed");
			result = JSON.parse(stdout) as BuildResult;
		}
		if (result.built) {
			copyPublicAssets(input.snapshot, output);
			const style = existsSync(join(output, "app.css"))
				? '<link rel="stylesheet" href="./app.css">'
				: "";
			const mountId = input.snapshot.project.mountId ?? "app";
			if (input.mode === "host" && input.snapshot.project.mountId)
				appendFileSync(
					join(output, "app.js"),
					'\n;if (window.parent !== window) { const beat = () => window.parent.postMessage({type:"eumenes-prototype-heartbeat"}, "*"); beat(); setInterval(beat, 1000); }\n',
				);
			const samples =
				input.mode === "standalone" &&
				[...input.snapshot.files.keys()].some((path) =>
					/^samples\/.+\.(png|webp|svg)$/.test(path),
				)
					? '<meta name="works-image-samples" content="true">'
					: "";
			writeFileSync(
				join(output, "index.html"),
				'<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Works</title>' +
					style +
					samples +
					`<div id="${mountId}"></div><script type="module" src="./app.js"></script></html>`,
			);
			mkdirSync(dirname(input.target), { recursive: true, mode: 0o700 });
			chmodSync(output, 0o700);
			renameSync(output, input.target);
		}
		return result;
	} finally {
		rmSync(task, { recursive: true, force: true });
	}
}
