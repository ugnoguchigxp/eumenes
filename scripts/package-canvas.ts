/** Canvasのソース配布物を、ホストのPlaywrightと型宣言を使うBunパッケージへ整える。 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const source = resolve(process.argv[2] ?? join(root, "../eumenes_canvas"));
const output = join(root, "vendor/canvas");
const temporary = mkdtempSync(join(tmpdir(), "eumenes-canvas-package-"));
const hash = (bytes: string | Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: source, encoding: "utf8" });
const entries = [
	"core/service",
	"core/store",
	"core/observer",
	"core/prompt-maker",
	"core/inference",
	"core/harness-session",
	"core/prompt-evaluator",
	"core/probes",
	"core/host-reviewer",
	"core/artwork-catalog",
	"server/preview",
];

function fixTimestamps(tar: Buffer) {
	for (let offset = 0; offset < tar.length && tar[offset] !== 0;) {
		const header = tar.subarray(offset, offset + 512);
		if (header.toString("ascii", 257, 263) !== "ustar\0" || header[156] !== 48)
			throw new Error("canvas_archive_format");
		const size = Number.parseInt(
			header.toString("ascii", 124, 136).replace(/[\0 ]+$/, ""),
			8,
		);
		header.write("00000000000\0", 136, "ascii");
		header.fill(32, 148, 156);
		header.write(
			header
				.reduce((sum, byte) => sum + byte, 0)
				.toString(8)
				.padStart(6, "0") + "\0 ",
			148,
			"ascii",
		);
		offset += 512 * (1 + Math.ceil(size / 512));
	}
}

try {
	execFileSync(
		process.execPath,
		["scripts/pack-canvas.ts", join(temporary, "raw")],
		{ cwd: source, stdio: "pipe" },
	);
	const rawName = readdirSync(join(temporary, "raw")).find((name) =>
		name.endsWith(".tgz"),
	)!;
	const rawBytes = readFileSync(join(temporary, "raw", rawName));
	const rawFiles = await new Bun.Archive(rawBytes).files();
	const files: Record<string, Buffer> = {};
	for (const [name, file] of rawFiles)
		files[name] = Buffer.from(await file.arrayBuffer());
	execFileSync(
		process.execPath,
		[
			join(source, "node_modules/typescript/bin/tsc"),
			"--declaration",
			"--emitDeclarationOnly",
			"--noEmit",
			"false",
			"--allowJs",
			"--outDir",
			join(temporary, "types"),
			"--rootDir",
			join(source, "src"),
			"--types",
			"bun",
			"--esModuleInterop",
			"--strict",
			"--skipLibCheck",
			"--target",
			"ES2022",
			"--module",
			"ESNext",
			"--moduleResolution",
			"Bundler",
			...entries.map((entry) => join(source, "src", entry + ".ts")),
		],
		{ cwd: source, stdio: "inherit" },
	);
	function declarations(directory: string, prefix = "types") {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.isDirectory())
				declarations(join(directory, entry.name), `${prefix}/${entry.name}`);
			else
				files[`${prefix}/${entry.name}`] = readFileSync(
					join(directory, entry.name),
				);
		}
	}
	declarations(join(temporary, "types"));
	const pkg = JSON.parse(files["package.json"]!.toString());
	delete pkg.dependencies["@playwright/test"];
	pkg.exports = {
		"./package.json": "./package.json",
		...Object.fromEntries(
			entries.map((entry) => [
				`./src/${entry}`,
				{ types: `./types/${entry}.d.ts`, default: `./src/${entry}.ts` },
			]),
		),
	};
	files["package.json"] = Buffer.from(JSON.stringify(pkg, null, 2) + "\n");
	const lock = JSON.parse(files["bun.lock"]!.toString());
	delete lock.workspaces[""].dependencies["@playwright/test"];
	files["bun.lock"] = Buffer.from(JSON.stringify(lock, null, 2) + "\n");
	const manifest = JSON.parse(files["canvas-package.json"]!.toString());
	delete files["canvas-package.json"];
	manifest.sha256 = Object.fromEntries(
		Object.entries(files).map(([name, bytes]) => [name, hash(bytes)]),
	);
	files["canvas-package.json"] = Buffer.from(
		JSON.stringify(manifest, null, 2) + "\n",
	);
	const tar = Buffer.from(
		await new Bun.Archive(
			Object.fromEntries(
				Object.entries(files)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([name, bytes]) => [`package/${name}`, bytes]),
			),
		).bytes(),
	);
	fixTimestamps(tar);
	const bytes = Bun.gzipSync(tar);
	const digest = hash(bytes);
	const archive = `eumenes-canvas-${pkg.version}-${digest.slice(0, 12)}.tgz`;
	mkdirSync(output, { recursive: true });
	writeFileSync(join(output, archive), bytes);
	writeFileSync(join(output, archive + ".sha256"), `${digest}  ${archive}\n`);
	let patch = git(
		"diff",
		"--binary",
		"--",
		"src",
		"tests",
		"package.json",
		"scripts",
	);
	for (const name of git(
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
		"--",
		"src",
		"tests",
		"scripts",
	)
		.split("\0")
		.filter(Boolean)) {
		const result = Bun.spawnSync(
			["git", "diff", "--no-index", "--binary", "--", "/dev/null", name],
			{ cwd: source },
		);
		if (result.exitCode !== 1) throw new Error("canvas_source_patch_failed");
		patch += result.stdout.toString();
	}
	const sourcePatch = "improvement-source.patch";
	writeFileSync(join(output, sourcePatch), patch);
	cpSync(join(source, "src/host/app.js"), join(output, "workbench/app.js"));
	const provenance = JSON.parse(
		readFileSync(join(output, "provenance.json"), "utf8"),
	);
	Object.assign(provenance, {
		version: pkg.version,
		sourceCommit: git("rev-parse", "HEAD").trim(),
		workingTreeChanges: manifest.workingTreeChanges,
		sourceArchive: rawName,
		sourceArchiveSha256: hash(rawBytes),
		archive,
		archiveSha256: digest,
		sourcePatch,
		sourcePatchSha256: hash(patch),
		layout:
			"Bun package/ prefix. Runtime sources and docs match the recorded source plus patch. Host Playwright is reused; declarations and package exports are generated by scripts/package-canvas.ts.",
	});
	provenance.workbenchFiles["app.js"] = hash(
		readFileSync(join(output, "workbench/app.js")),
	);
	writeFileSync(
		join(output, "provenance.json"),
		JSON.stringify(provenance, null, "\t") + "\n",
	);
	const packagePath = join(root, "package.json");
	const previous = readFileSync(packagePath, "utf8");
	const currentArchive =
		/"eumenes-canvas": "file:vendor\/canvas\/([^"]+)"/.exec(previous)?.[1];
	if (!currentArchive) throw new Error("canvas_dependency_missing");
	writeFileSync(packagePath, previous.replaceAll(currentArchive, archive));
	console.log(
		JSON.stringify({
			archive,
			digest,
			sourceCommit: provenance.sourceCommit,
			workingTreeChanges: manifest.workingTreeChanges,
		}),
	);
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
