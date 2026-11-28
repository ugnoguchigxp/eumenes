import {
	constants,
	lstatSync,
	realpathSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	runnerFor,
	groupTests,
	testCommand,
	testPattern,
} from "../../../scripts/verification-selection";
import { domains } from "../../../scripts/domains";
import type { VerificationReport } from "../../../scripts/verification-run";
import { SENSITIVE_FILE_GLOBS } from "../../../packages/coding-runner/src/sdk-sensitive-files";
import { git, resolveSourceCommit } from "../web-note/source-snapshot";
import { runGoalCheck } from "./goal-verification";

const node = Bun.which("node");
const path = [
	...new Set([
		dirname(process.execPath),
		...(node ? [dirname(node)] : []),
		"/usr/bin",
		"/bin",
	]),
].join(":");

function domainVerificationPath() {
	let executable = Bun.which("git");
	if (process.platform === "darwin" && executable === "/usr/bin/git") {
		// Apple's /usr/bin/git wrapper tries to write an xcrun cache outside TMPDIR.
		const native = Bun.spawnSync(["/usr/bin/xcrun", "--find", "git"], {
			stderr: "ignore",
		});
		if (native.exitCode === 0) executable = native.stdout.toString().trim();
	}
	return executable ? `${dirname(executable)}:${path}` : path;
}
const contained = (root: string, target: string) => {
	const rel = relative(root, target);
	return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
};
const secret = /^(?:secrets?|credentials?)$/iu;
const sensitive = SENSITIVE_FILE_GLOBS.map((pattern) => new Bun.Glob(pattern));

export function checkoutProtection(
	root: string,
	configured: readonly string[] = [],
) {
	return [
		...new Set([
			join(root, "data"),
			join(root, ".env"),
			join(root, ".env.local"),
			...configured,
		]),
	];
}

export async function checkoutFiles(
	root: string,
	protectedPaths: readonly string[],
	signal: AbortSignal,
) {
	const listed = await git(
		root,
		["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
		2 * 1024 * 1024,
		signal,
	);
	return [...new Set(listed.toString().split("\0"))].filter((file) => {
		if (
			!file ||
			file.split("/").some((part) => secret.test(part)) ||
			sensitive.some((glob) => glob.match(file))
		)
			return false;
		const candidate = resolve(root, file);
		try {
			return (
				contained(root, candidate) &&
				realpathSync(candidate) === candidate &&
				lstatSync(candidate).isFile() &&
				!protectedPaths.some((protectedPath) =>
					contained(protectedPath, candidate),
				)
			);
		} catch {
			return false;
		}
	});
}

export const checkoutTestFiles = (files: readonly string[]) =>
	files.filter((file) => testPattern.test(file) && runnerFor(file));

const generatedDependencies = [".vite", ".vite-temp", ".cache"];

function linkDependencies(source: string, target: string) {
	mkdirSync(target, { recursive: true });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		if (generatedDependencies.includes(entry.name)) continue;
		const original = join(source, entry.name);
		const destination = join(target, entry.name);
		if (entry.isDirectory() && entry.name.startsWith("@")) {
			linkDependencies(original, destination);
			continue;
		}
		// Relative workspace links resolve against the copy. Installed packages are
		// shared read-only by the check sandbox, including Bun's package store.
		symlinkSync(
			entry.isSymbolicLink() ? readlinkSync(original) : original,
			destination,
		);
	}
}

async function snapshot(
	root: string,
	copy: string,
	files: readonly string[],
	signal: AbortSignal,
) {
	const head = await resolveSourceCommit(root, signal);
	for (const file of files) {
		signal.throwIfAborted();
		const target = join(copy, file);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(join(root, file), target, constants.COPYFILE_FICLONE);
	}
	const packageRoots = new Set([
		".",
		...files.filter((file) => file.endsWith("/package.json")).map(dirname),
	]);
	for (const dir of packageRoots) {
		signal.throwIfAborted();
		const dependencies = join(root, dir, "node_modules");
		if (existsSync(dependencies))
			linkDependencies(dependencies, join(copy, dir, "node_modules"));
	}
	// The project verifier records the original commit. Retain the head object
	// without copying the repository's trees or history.
	const commit = await git(
		root,
		["cat-file", "commit", head],
		256 * 1024,
		signal,
	);
	await git(copy, ["init", "--quiet", "--initial-branch=main"], 4_096, signal);
	const saved = await git(
		copy,
		["hash-object", "-t", "commit", "-w", "--stdin"],
		128,
		signal,
		commit,
	);
	if (saved.toString().trim() !== head)
		throw new Error("goal_verification_base_changed");
	writeFileSync(join(copy, ".git/refs/heads/main"), head + "\n");
}

function command(runner: keyof ReturnType<typeof groupTests>, files: string[]) {
	if (node && (runner === "web" || runner === "client"))
		return [
			node,
			"node_modules/vitest/vitest.mjs",
			"run",
			"--configLoader",
			"runner",
			"--no-cache",
			"--reporter=verbose",
			...files,
		];
	// The package's own script bundles its Vite config into node_modules, which the check may not write.
	if (node && runner === "design-system")
		return [
			node,
			"packages/design-system/node_modules/vitest/vitest.mjs",
			"run",
			"--root",
			"packages/design-system",
			"--project",
			"unit",
			"--configLoader",
			"runner",
			"--no-cache",
			"--reporter=verbose",
			...files.map((path) => path.replace(/^packages\/design-system\//, "")),
		];
	return testCommand(runner, files);
}

export function testRunPassed(
	files: readonly string[],
	result: Awaited<ReturnType<typeof runGoalCheck>>,
) {
	if (result.exitCode !== 0 || files.length === 0) return false;
	const lines = Bun.stripANSI(result.stdout + "\n" + result.stderr).split("\n");
	const passed = new Set<string>();
	let bunFile: string | undefined;
	for (const line of lines) {
		const bunHeader = /^(.+\.(?:test|spec)\.[cm]?[jt]sx?):$/u.exec(line);
		if (bunHeader) bunFile = bunHeader[1];
		else if (bunFile && line.startsWith("(pass) ")) passed.add(bunFile);
		const vitest =
			/^\s*✓ +(?:[^\s/]+ {2})?(.+?\.(?:test|spec)\.[cm]?[jt]sx?)(?: > | \([1-9]\d* tests?\))/u.exec(
				line,
			);
		if (vitest?.[1]) passed.add(vitest[1]);
	}
	return files.every(
		(file) =>
			passed.has(file) ||
			(file.startsWith("packages/design-system/") &&
				passed.has(file.slice("packages/design-system/".length))),
	);
}

function readDomainReport(copy: string, selected: readonly string[]) {
	try {
		const report = JSON.parse(
			readFileSync(join(copy, "verification-reports/latest.json"), "utf8"),
		) as VerificationReport;
		if (
			report.schemaVersion !== 1 ||
			report.scope.all ||
			JSON.stringify(report.scope.selected) !== JSON.stringify(selected)
		)
			return null;
		const steps = report.steps.map(({ name, status, failures }) => ({
			name,
			status,
			...(failures?.length && { failures: failures.slice(0, 6) }),
		}));
		return {
			result: report.result,
			steps,
			passed:
				report.result === "pass" &&
				steps.some(
					({ name, status }) => name.endsWith(" tests") && status === "pass",
				),
		};
	} catch {
		return null;
	}
}

export async function runCheckoutTests(
	root: string,
	criterion: { testFiles: string[]; domains: string[] },
	files: readonly string[],
	protectedPaths: readonly string[],
	signal: AbortSignal,
) {
	const results: {
		tests: string[];
		domains: string[];
		exitCode: number | null;
		output: string;
		passed: boolean;
	}[] = [];
	const policy = { protectedPaths, path };
	for (const [runner, tests] of Object.entries(
		groupTests(criterion.testFiles),
	)) {
		if (!tests.length) continue;
		const [executable, ...args] = command(
			runner as keyof ReturnType<typeof groupTests>,
			tests,
		);
		const result = await runGoalCheck(
			root,
			{ ref: runner, command: executable!, args, cwd: root },
			signal,
			policy,
		);
		results.push({
			tests,
			domains: [],
			exitCode: result.exitCode,
			output: Bun.stripANSI(result.stdout + "\n" + result.stderr).slice(
				-12_000,
			),
			passed: testRunPassed(tests, result),
		});
	}
	if (criterion.domains.length) {
		if (!criterion.domains.every((domain) => Object.hasOwn(domains, domain)))
			throw new Error("goal_verification_domain_invalid");
		const copy = mkdtempSync(
			join(realpathSync(tmpdir()), "eumenes-goal-checkout-"),
		);
		try {
			await snapshot(root, copy, files, signal);
			const writablePaths = [
				"verification-reports",
				"packages/design-system/dist",
				...["node_modules", "packages/design-system/node_modules"].flatMap(
					(dir) => generatedDependencies.map((name) => join(dir, name)),
				),
			].map((dir) => join(copy, dir));
			for (const dir of writablePaths) mkdirSync(dir, { recursive: true });
			const result = await runGoalCheck(
				copy,
				{
					ref: "domain",
					command: process.execPath,
					args: [
						"run",
						"verify",
						"--",
						...criterion.domains.flatMap((domain) => ["--domain", domain]),
					],
					cwd: copy,
				},
				signal,
				{
					...policy,
					path: domainVerificationPath(),
					writablePaths,
					timeoutMs: 120_000,
				},
			);
			const report = readDomainReport(copy, criterion.domains);
			results.push({
				tests: [],
				domains: criterion.domains,
				exitCode: result.exitCode,
				output: report
					? JSON.stringify(report).slice(0, 12_000)
					: Bun.stripANSI(result.stderr || result.stdout).slice(-12_000),
				passed: result.exitCode === 0 && !!report?.passed,
			});
		} finally {
			rmSync(copy, { recursive: true, force: true });
		}
	}
	return results;
}
