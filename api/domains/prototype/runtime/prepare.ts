import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { filesForRelease, lockFile, releaseDigest, type Pin } from "./release";
import { isInside, versionPattern } from "./project";

function gitBytes(source: string, args: string[]) {
	const result = Bun.spawnSync(
		["/usr/bin/git", "-C", source, "-c", "core.hooksPath=/dev/null", ...args],
		{
			env: {
				PATH: "/usr/bin:/bin",
				GIT_NO_REPLACE_OBJECTS: "1",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				HOME: "/nonexistent",
			},
			stderr: "ignore",
			stdout: "pipe",
			timeout: 15_000,
		},
	);
	if (result.exitCode !== 0)
		throw new Error("prototype_release_source_invalid");
	return Buffer.from(result.stdout);
}

const maxBytes = 512 * 1024 * 1024;
const slug = (version: string) => {
	if (!versionPattern.test(version))
		throw new Error("prototype_environment_invalid");
	return "refs/tags/works-v" + version + "^{commit}";
};

export function pin(source: string, version: string) {
	const commit = gitBytes(source, ["rev-parse", slug(version)])
		.toString()
		.trim();
	if (!/^[0-9a-f]{40,64}$/.test(commit))
		throw new Error("prototype_environment_invalid");
	const file = (name: string) =>
		gitBytes(source, ["show", commit + ":" + name]);
	return { value: { commit, digest: releaseDigest(version, file) }, file };
}

function size(directory: string): number {
	return readdirSync(directory).reduce((total, name) => {
		const path = join(directory, name);
		const stat = lstatSync(path);
		return (
			total + (stat.isDirectory() ? size(path) : stat.isFile() ? stat.size : 0)
		);
	}, 0);
}

export function install(
	root: string,
	source: string,
	version: string,
	expected: Pin,
) {
	const candidate = pin(source, version);
	if (
		candidate.value.commit !== expected.commit ||
		candidate.value.digest !== expected.digest
	)
		throw new Error("prototype_release_pin_mismatch");
	for (const name of ["releases", "pins", "locks", "cache", "bin"])
		mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
	const releaseRoot = join(root, "releases");
	const destination = join(releaseRoot, version);
	const record = join(root, "pins", version + ".json");
	const cache = join(root, "cache");
	const unlock = lockFile(join(root, "locks", "install"), true);
	let stage: string | undefined;
	let cacheBefore: Set<string> | undefined;
	let installedRelease = false;
	const releases: Array<{ path: string; unlock(): void }> = [];
	try {
		if (existsSync(record)) {
			const old = JSON.parse(readFileSync(record, "utf8")) as Pin;
			if (old.commit !== expected.commit || old.digest !== expected.digest)
				throw new Error("prototype_release_already_pinned");
		}
		if (existsSync(destination)) {
			if (
				releaseDigest(version, (name) =>
					readFileSync(join(destination, name)),
				) !== expected.digest
			)
				throw new Error("prototype_environment_invalid");
			utimesSync(destination, new Date(), new Date());
			return;
		}
		stage = mkdtempSync(join(root, "staging-"));
		cacheBefore = new Set(readdirSync(cache));
		const installation = join(stage, "release");
		mkdirSync(installation);
		for (const name of filesForRelease(version))
			writeFileSync(join(installation, name), candidate.file(name));
		const result = Bun.spawnSync(
			[
				process.execPath,
				"--no-env-file",
				"install",
				"--frozen-lockfile",
				"--ignore-scripts",
				"--backend=clonefile",
				"--cache-dir=" + cache,
			],
			{
				cwd: installation,
				env: { HOME: stage, PATH: "/usr/bin:/bin", TMPDIR: stage },
				stdout: "ignore",
				stderr: "pipe",
				timeout: 120_000,
			},
		);
		if (result.exitCode !== 0)
			throw new Error("prototype_install_failed: " + result.stderr.toString());
		if (
			releaseDigest(version, (name) =>
				readFileSync(join(installation, name)),
			) !== expected.digest
		)
			throw new Error("prototype_install_changed_pinned_files");

		const installed = readdirSync(releaseRoot)
			.filter((item) => versionPattern.test(item))
			.map((item) => ({ version: item, path: join(releaseRoot, item) }))
			.sort((a, b) => lstatSync(a.path).mtimeMs - lstatSync(b.path).mtimeMs);
		let remaining = size(cache) + size(installation) + size(releaseRoot);
		for (const item of installed) {
			if (installed.length - releases.length < 2 && remaining <= maxBytes)
				break;
			try {
				const close = lockFile(join(root, "locks", item.version), true);
				releases.push({ path: item.path, unlock: close });
				remaining -= size(item.path);
			} catch (error) {
				if ((error as Error).message !== "prototype_release_busy") throw error;
			}
		}
		if (remaining > maxBytes || installed.length - releases.length >= 2)
			throw new Error("prototype_release_retention_limit");
		// The pinned record exists before the directory becomes discoverable.
		if (!existsSync(record))
			writeFileSync(record, JSON.stringify(expected), {
				flag: "wx",
				mode: 0o600,
			});
		try {
			for (const [i, item] of releases.entries()) {
				renameSync(item.path, join(stage, "retired-" + i));
			}
			renameSync(installation, destination);
			installedRelease = true;
		} finally {
			if (!installedRelease)
				for (const [i, item] of releases.entries()) {
					const moved = join(stage, "retired-" + i);
					if (existsSync(moved)) renameSync(moved, item.path);
				}
		}
	} finally {
		try {
			if (!installedRelease && cacheBefore)
				for (const name of readdirSync(cache)) {
					if (!cacheBefore.has(name))
						rmSync(join(cache, name), { recursive: true, force: true });
				}
			if (stage) rmSync(stage, { recursive: true, force: true });
		} finally {
			for (const item of releases) item.unlock();
			unlock();
		}
	}
}

const launcher = `#!/bin/sh
set -eu
project=$(pwd -P)
: "\${EUMENES_PROTOTYPE_HOME:?Set EUMENES_PROTOTYPE_HOME to the prepared Works environment}"
cd "$EUMENES_PROTOTYPE_HOME"
exec bun --no-env-file --no-install --config="$PWD/launcher/bunfig.toml" "$PWD/launcher/dispatch.ts" "$project" "$@"
`;
const dispatch = `import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { collect } from "./project";
import { openRelease } from "./release";
const [project, ...args] = process.argv.slice(2);
const home = realpathSync(dirname(import.meta.dir));
const data = collect(project);
const active = openRelease(home, data.project.environment);
try {
	const child = Bun.spawn([
		process.execPath, "--no-env-file", "--no-install", "--config=" + join(import.meta.dir, "bunfig.toml"),
		join(active.path, "standalone.ts"), ...args,
	], { cwd: home, env: { PATH: process.env.PATH, EUMENES_PROTOTYPE_HOME: home, EUMENES_PROTOTYPE_PROJECT: project },
		stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	const forward = (signal) => child.kill(signal);
	process.on("SIGTERM", forward);
	process.on("SIGINT", forward);
	try { process.exitCode = await child.exited; } finally {
		process.removeListener("SIGTERM", forward);
		process.removeListener("SIGINT", forward);
	}
} finally { active.close(); }
`;

function writeLauncher(root: string) {
	const target = join(root, "launcher");
	if (!existsSync(target)) {
		mkdirSync(target, { mode: 0o700 });
		for (const file of ["project.ts", "release.ts"])
			copyFileSync(join(import.meta.dir, file), join(target, file));
		writeFileSync(join(target, "dispatch.ts"), dispatch);
		writeFileSync(join(target, "bunfig.toml"), "");
		writeFileSync(join(root, "bin", "eumenes-prototype"), launcher, {
			mode: 0o755,
		});
	}
}

export function prepare(args: string[], protectedRoot?: string) {
	const [command, arg, source, version, commit, digest] = args;
	if (command === "pin" && arg && source) {
		console.log(JSON.stringify(pin(realpathSync(arg), source).value));
	} else if (
		command === "install" &&
		arg &&
		source &&
		version &&
		commit &&
		digest
	) {
		const given = resolve(arg);
		const sourceRoot = realpathSync(source);
		const forbidden = (path: string) =>
			isInside(sourceRoot, path) ||
			isInside(path, sourceRoot) ||
			(protectedRoot &&
				(isInside(protectedRoot, path) || isInside(path, protectedRoot)));
		if (forbidden(given))
			throw new Error("prototype_runtime_outside_core_required");
		mkdirSync(given, { recursive: true, mode: 0o700 });
		const root = realpathSync(given);
		if (forbidden(root))
			throw new Error("prototype_runtime_outside_core_required");
		install(root, sourceRoot, version, { commit, digest });
		writeLauncher(root);
	} else
		throw new Error(
			"Usage: prepare.ts pin <source-dir> <version> | install <home> <source-dir> <version> <commit> <sha256>",
		);
}

if (import.meta.main) {
	try {
		prepare(process.argv.slice(2));
	} catch (error) {
		console.error((error as Error).message);
		process.exitCode = 1;
	}
}
