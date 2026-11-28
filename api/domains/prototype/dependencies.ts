import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
	mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { collect, isInside } from "./runtime/project";
import { lockFile, openRelease, filesForRelease } from "./runtime/release";
import { runBuild } from "./runtime/build";
import { pin } from "./runtime/prepare";

type Package = { name: string; version: string; entry: string; types: string };
type Publication = {
	id: string;
	environment: string;
	request: Package;
	signal: AbortSignal;
	assertCurrent(alreadyPublished?: string): void;
};
type Integrity = { integrity: string; tarball: string };
type Metadata = {
	time?: Record<string, string>;
	versions?: Record<
		string,
		{
			dist?: Integrity;
			scripts?: Record<string, string>;
			gypfile?: boolean;
			dependencies?: Record<string, string>;
			optionalDependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
		}
	>;
};
const packagePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const versionPattern = /^\d+\.\d+\.\d+$/;
const registry = "https://registry.npmjs.org";
const minimumAge = 7 * 24 * 60 * 60_000;
const changingFiles = ["package.json", "bun.lock", "resolution.json"];
const resolveFiles = (p: Package) => [
	`node_modules/${p.name}/${p.entry}`,
	`node_modules/${p.name}/${p.types}`,
];
const parse = <T>(file: string) =>
	Bun.JSONC.parse(readFileSync(file, "utf8")) as T;
const write = (file: string, value: unknown) =>
	writeFileSync(file, JSON.stringify(value, null, "\t") + "\n");
const unsupported = () => new Error("prototype_dependency_unsupported_source");

async function npmMetadata(name: string, signal: AbortSignal) {
	if (!packagePattern.test(name)) throw unsupported();
	const response = await fetch(registry + "/" + encodeURIComponent(name), {
		signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
		redirect: "error",
	});
	if (!response.ok)
		throw new Error("prototype_dependency_registry_unavailable");
	const body = await response.text();
	if (Buffer.byteLength(body) > 32 * 1024 * 1024)
		throw new Error("prototype_dependency_registry_unavailable");
	return JSON.parse(body) as Metadata;
}

export function verifyDependencyVersion(
	name: string,
	version: string,
	metadata: Metadata,
) {
	if (!packagePattern.test(name) || !versionPattern.test(version))
		throw unsupported();
	const row = metadata.versions?.[version];
	if (
		!row?.dist ||
		!row.dist.tarball.startsWith(registry + "/") ||
		!/^sha512-[A-Za-z0-9+/=]+$/.test(row.dist.integrity) ||
		Buffer.from(row.dist.integrity.slice(7), "base64").byteLength !== 64
	)
		throw unsupported();
	const published = Date.parse(metadata.time?.[version] ?? "");
	if (!Number.isFinite(published) || Date.now() - published < minimumAge)
		throw new Error("prototype_dependency_too_recent");
	if (
		row.gypfile ||
		[
			"preinstall",
			"install",
			"postinstall",
			"preprepare",
			"prepare",
			"postprepare",
		].some((name) => row.scripts?.[name])
	)
		throw new Error("prototype_dependency_requires_install_script");
	const ranges = Object.values({
		...row.dependencies,
		...row.optionalDependencies,
		...row.peerDependencies,
	});
	if (
		ranges.some(
			(range) =>
				typeof range !== "string" || !/^[0-9vxX*~^<>=|. -]+$/.test(range),
		)
	)
		throw unsupported();
	return row.dist;
}

function command(
	cwd: string,
	args: string[],
	env: Record<string, string>,
	stdin?: string | Buffer,
	optional = false,
) {
	const result = Bun.spawnSync(args, {
		cwd,
		env,
		stdin: typeof stdin === "string" ? Buffer.from(stdin) : stdin,
		stdout: "pipe",
		stderr: "ignore",
		timeout: 15_000,
	});
	if (result.exitCode === 0) return Buffer.from(result.stdout);
	if (optional) return null;
	throw new Error("prototype_dependency_git_failed");
}

function gitPort(source: string, stage: string) {
	const env = {
		HOME: stage,
		PATH: "/usr/bin:/bin",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_INDEX_FILE: join(stage, "publish.index"),
		GIT_AUTHOR_NAME: "Eumenes Works",
		GIT_AUTHOR_EMAIL: "works@eumenes.invalid",
		GIT_COMMITTER_NAME: "Eumenes Works",
		GIT_COMMITTER_EMAIL: "works@eumenes.invalid",
	};
	return (args: string[], stdin?: string | Buffer, optional = false) =>
		command(
			source,
			["/usr/bin/git", "-c", "core.hooksPath=/dev/null", ...args],
			env,
			stdin,
			optional,
		);
}

type Git = ReturnType<typeof gitPort>;
const gitText = (git: Git, ...args: string[]) => git(args)!.toString().trim();
const tagRef = (version: string) => "refs/tags/works-v" + version;

function priorVersion(git: Git, operation: string) {
	const commit = git(
		["rev-parse", "--verify", operation + "^{commit}"],
		undefined,
		true,
	)
		?.toString()
		.trim();
	if (!commit) return undefined;
	const title = gitText(git, "show", "-s", "--format=%s", commit);
	const version = /^Works dependency ([1-9]\d*\.\d+)$/.exec(title)?.[1];
	if (!version || pinCommit(git, version) !== commit)
		throw new Error("prototype_dependency_publication_conflict");
	return version;
}

function pinCommit(git: Git, version: string) {
	return gitText(git, "rev-parse", tagRef(version) + "^{commit}");
}

type Lock = { packages: Record<string, [string, string, object, string]> };
async function validateLock(
	before: Lock,
	after: Lock,
	request: Package,
	signal: AbortSignal,
	primary: Integrity,
) {
	const locked = after.packages[request.name];
	if (
		!locked ||
		locked[0] !== request.name + "@" + request.version ||
		locked[3] !== primary.integrity
	)
		throw unsupported();
	let compatible = true;
	for (const [key, row] of Object.entries(before.packages)) {
		if (JSON.stringify(after.packages[key]) !== JSON.stringify(row))
			compatible = false;
	}
	const fresh = Object.entries(after.packages).filter(
		([key, row]) =>
			JSON.stringify(row) !== JSON.stringify(before.packages[key]),
	);
	if (fresh.length > 64) throw unsupported();
	for (const [, row] of fresh) {
		signal.throwIfAborted();
		const index = row[0].lastIndexOf("@");
		const name = row[0].slice(0, index);
		const version = row[0].slice(index + 1);
		if (index < 1 || (row[1] && !row[1].startsWith(registry + "/")))
			throw unsupported();
		const expected =
			name === request.name && version === request.version
				? primary
				: verifyDependencyVersion(
						name,
						version,
						await npmMetadata(name, signal),
					);
		if (row[3] !== expected.integrity) throw unsupported();
	}
	return compatible;
}

async function bunInstall(
	directory: string,
	args: string[],
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	const child = Bun.spawn(
		[
			process.execPath,
			"--no-env-file",
			"install",
			"--ignore-scripts",
			"--registry=" + registry,
			"--cache-dir=" + join(directory, ".cache"),
			...args,
		],
		{
			cwd: directory,
			env: { HOME: directory, PATH: "/usr/bin:/bin", TMPDIR: directory },
			stdout: "ignore",
			stderr: "ignore",
			signal,
			timeout: 90_000,
		},
	);
	if ((await child.exited) !== 0)
		throw new Error("prototype_dependency_install_failed");
	signal.throwIfAborted();
}

async function verifyBrowser(
	stage: string,
	request: Package,
	version: string,
	signal: AbortSignal,
) {
	const packageDir = realpathSync(join(stage, "node_modules", request.name));
	if (
		!isInside(stage, packageDir) ||
		existsSync(join(packageDir, "binding.gyp"))
	)
		throw new Error("prototype_dependency_requires_install_script");
	for (const name of resolveFiles(request)) {
		const path = realpathSync(join(stage, name));
		if (!isInside(packageDir, path) || !lstatSync(path).isFile())
			throw unsupported();
	}
	const project = join(stage, "browser-check");
	mkdirSync(join(project, "src"), { recursive: true });
	write(join(project, "prototype.json"), {
		schema: 1,
		name: "dependency verification",
		environment: version,
		entry: "src/app.ts",
		include: ["src"],
		features: [],
	});
	writeFileSync(
		join(project, "src/app.ts"),
		`import * as pkg from ${JSON.stringify(request.name)};\ndocument.body.dataset.works = Object.keys(pkg).join(",");\n`,
	);
	for (const mode of ["host", "standalone"] as const) {
		const output = await runBuild({
			runtime: stage,
			snapshot: collect(project),
			mode,
			build: true,
			strict: true,
			typecheck: true,
			target: join(project, "out-" + mode),
			work: join(project, "scratch"),
			signal,
		});
		if (!output.built || output.diagnostics.length)
			throw new Error("prototype_dependency_browser_check_failed");
	}
}

function nextVersion(tags: string[], current: string, compatible: boolean) {
	const [major, minor] = current.split(".").map(Number);
	const numbers = tags.map((tag) => tag.split(".").map(Number));
	if (!compatible)
		return Math.max(major!, ...numbers.map(([m]) => m!)) + 1 + ".0";
	return (
		major +
		"." +
		(Math.max(
			minor!,
			...numbers.filter(([m]) => m === major).map(([, v]) => v!),
		) +
			1)
	);
}

function commitRelease(
	git: Git,
	base: string,
	stage: string,
	version: string,
	operation: string,
) {
	git(["read-tree", base]);
	for (const file of changingFiles) {
		const blob = git(
			["hash-object", "-w", "--stdin"],
			readFileSync(join(stage, file)),
		)!
			.toString()
			.trim();
		git([
			"update-index",
			"--add",
			"--cacheinfo",
			"100644," + blob + "," + file,
		]);
	}
	const tree = gitText(git, "write-tree");
	const commit = gitText(
		git,
		"commit-tree",
		tree,
		"-p",
		base,
		"-m",
		"Works dependency " + version,
	);
	git(
		["update-ref", "--stdin"],
		`start\ncreate ${tagRef(version)} ${commit}\ncreate ${operation} ${commit}\nprepare\ncommit\n`,
	);
}

async function installPublished(home: string, source: string, version: string) {
	const { commit, digest } = pin(source, version).value;
	const installer = join(import.meta.dir, "runtime");
	// Once a tag is published, let its installation reach a consistent state even if its work is cancelled.
	const child = Bun.spawn(
		[
			process.execPath,
			"--no-env-file",
			"--no-install",
			"--no-macros",
			"--config=" + join(installer, "bunfig.toml"),
			"--cwd=" + installer,
			join(installer, "prepare.ts"),
			"install",
			home,
			source,
			version,
			commit,
			digest,
		],
		{
			cwd: installer,
			env: { HOME: "/nonexistent", PATH: "/usr/bin:/bin" },
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			timeout: 135_000,
		},
	);
	if ((await child.exited) !== 0)
		throw new Error("prototype_dependency_install_failed");
}

async function publishPinned(
	source: string,
	home: string,
	stage: string,
	input: Publication,
) {
	const git = gitPort(source, stage);
	const operation = "refs/eumenes/works-approval/" + input.id;
	const existing = priorVersion(git, operation);
	if (existing) {
		input.assertCurrent(existing);
		await installPublished(home, source, existing);
		return existing;
	}
	input.assertCurrent();
	const onDisk = openRelease(home, input.environment);
	try {
		const basePin = parse<{ commit: string; digest: string }>(
			join(home, "pins", input.environment + ".json"),
		);
		const base = pin(source, input.environment);
		if (
			base.value.commit !== basePin.commit ||
			base.value.digest !== basePin.digest
		)
			throw new Error("prototype_dependency_publication_conflict");
		const tags = gitText(git, "tag", "--list", "works-v*")
			.split("\n")
			.map((tag) => tag.match(/^works-v([1-9]\d*\.\d+)$/)?.[1])
			.filter((value): value is string => !!value);
		const series = input.environment.split(".")[0];
		const latest =
			tags
				.filter((tag) => tag.split(".")[0] === series)
				.sort((a, b) => Number(b.split(".")[1]) - Number(a.split(".")[1]))[0] ??
			input.environment;
		const parent = pin(source, latest);
		for (const file of filesForRelease(latest))
			writeFileSync(join(stage, file), parent.file(file));
		const manifest = parse<{
			dependencies: Record<string, string>;
			devDependencies?: Record<string, string>;
		}>(join(stage, "package.json"));
		const resolutions = parse<Record<string, string[]>>(
			join(stage, "resolution.json"),
		);
		const request = input.request;
		if (
			Object.hasOwn(manifest.dependencies, request.name) ||
			Object.hasOwn(manifest.devDependencies ?? {}, request.name) ||
			Object.hasOwn(resolutions, request.name)
		)
			throw new Error("prototype_dependency_already_registered");
		const integrity = verifyDependencyVersion(
			request.name,
			request.version,
			await npmMetadata(request.name, input.signal),
		);
		const lock = join(stage, "bun.lock");
		const before = parse<Lock>(lock);
		manifest.dependencies = {
			...manifest.dependencies,
			[request.name]: request.version,
		};
		write(join(stage, "package.json"), manifest);
		write(join(stage, "resolution.json"), {
			...resolutions,
			[request.name]: resolveFiles(request),
		});
		await bunInstall(stage, ["--lockfile-only"], input.signal);
		const compatible = await validateLock(
			before,
			parse<Lock>(lock),
			request,
			input.signal,
			integrity,
		);
		await bunInstall(stage, ["--frozen-lockfile"], input.signal);
		const version = nextVersion(tags, latest, compatible);
		await verifyBrowser(stage, request, version, input.signal);
		input.assertCurrent();
		commitRelease(git, parent.value.commit, stage, version, operation);
		await installPublished(home, source, version);
		return version;
	} finally {
		onDisk.close();
	}
}

export function worksDependencyPublisher(
	sourceGiven: string,
	homeGiven: string,
	forbidden: readonly string[],
) {
	const source = realpathSync(sourceGiven);
	const home = realpathSync(homeGiven);
	if (
		[home, ...forbidden.map((path) => realpathSync(path))].some(
			(path) => isInside(path, source) || isInside(source, path),
		)
	)
		throw new Error("prototype_runtime_outside_core_required");
	const inspect = (flag: string) =>
		command(
			source,
			["/usr/bin/git", "rev-parse", "--path-format=absolute", flag],
			{
				PATH: "/usr/bin:/bin",
				HOME: "/nonexistent",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
			},
		)!
			.toString()
			.trim();
	const common = realpathSync(inspect("--git-common-dir"));
	if (
		inspect("--show-toplevel") !== source ||
		!isInside(source, common) ||
		realpathSync(inspect("--absolute-git-dir")) !== common
	)
		throw new Error("prototype_release_source_invalid");
	return async (input: Publication) => {
		const stage = mkdtempSync(join(home, "publication-"));
		let unlock: (() => void) | undefined;
		try {
			unlock = lockFile(join(home, "locks", "publication"), true);
			return await publishPinned(source, home, stage, input);
		} finally {
			unlock?.();
			rmSync(stage, { recursive: true, force: true });
		}
	};
}
