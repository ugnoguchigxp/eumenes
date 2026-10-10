import { createHash } from "node:crypto";
import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "packages", "design-system");
const stampPath = join(root, "dist", ".build-stamp");
const inputFiles = [
	"package.json",
	"tsconfig.json",
	"tsconfig.build.json",
	"vite.config.ts",
];
const entryFiles = [
	"dist/index.js",
	"dist/index.mjs",
	"dist/index.d.ts",
	"dist/design-system.css",
];

function listFiles(dir: string): string[] {
	const files: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) files.push(...listFiles(path));
		else files.push(path);
	}
	return files;
}

export function computeSourceHash(base: string): string {
	const srcDir = join(base, "src");
	const paths = [
		...(existsSync(srcDir) ? listFiles(srcDir) : []),
		...inputFiles
			.map((name) => join(base, name))
			.filter((path) => existsSync(path)),
	]
		.map((path) => relative(base, path).split("\\").join("/"))
		.sort();
	const hash = createHash("sha256");
	for (const path of paths) {
		hash.update(`${path}\0`);
		hash.update(readFileSync(join(base, path)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

if (import.meta.main) {
	const hash = computeSourceHash(root);
	const current = existsSync(stampPath)
		? readFileSync(stampPath, "utf8").trim()
		: "";
	const built = entryFiles.every((file) => existsSync(join(root, file)));
	if (current === hash && built) {
		console.log("design-system: up to date, skip build");
		process.exit(0);
	}
	const result = Bun.spawnSync(["bun", "run", "--cwd", root, "build"], {
		stdout: "inherit",
		stderr: "inherit",
	});
	if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
	writeFileSync(stampPath, `${hash}\n`);
}
