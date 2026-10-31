import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { applicationDomainEntries } from "./boundaries";
import { type Domain, domains, ownedPaths } from "./domains";

export function parseSelection(raw: string[], legacy = false) {
	const args = raw.filter((arg) => arg !== "--");
	const selected: Domain[] = [];
	let all = false;
	let sub: string | undefined;
	function add(value: string | undefined) {
		if (!value || !Object.hasOwn(domains, value))
			throw new Error(`Unknown domain: ${value ?? "(missing)"}`);
		if (!selected.includes(value as Domain)) selected.push(value as Domain);
	}
	if (legacy && args[0] && !args[0].startsWith("--")) {
		if (args.length > 2)
			throw new Error("Use repeated --domain for multiple domains");
		add(args[0]);
		sub = args[1];
		if (sub && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sub))
			throw new Error("Invalid subdomain name");
	} else {
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "--domain") add(args[++i]);
			else if (args[i] === "--all" && !legacy && !all) all = true;
			else throw new Error(`Unexpected argument: ${args[i]}`);
		}
	}
	if ((all && selected.length) || (!all && !selected.length))
		throw new Error("Use --all or one or more --domain <name>");
	return {
		all,
		selected: all ? (Object.keys(domains) as Domain[]) : selected,
		sub,
	};
}

export function sourceFiles(root: string, directory: string): string[] {
	let entries;
	try {
		entries = readdirSync(join(root, directory), { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return entries
		.flatMap((entry): string[] => {
			if (
				[
					"node_modules",
					".git",
					".serena",
					"dist",
					"dist-web",
					"data",
					"verification-reports",
					"test-results",
					"playwright-report",
				].includes(entry.name)
			)
				return [];
			const path = directory ? `${directory}/${entry.name}` : entry.name;
			if (entry.isDirectory()) return sourceFiles(root, path);
			return entry.isFile() ? [path] : [];
		})
		.sort();
}

/** Application tests that import one of the selected domains' public entries. */
export function integrationTestFiles(root: string, selected: Domain[]) {
	const wanted = new Set(selected);
	return sourceFiles(root, "api/application").filter((path) => {
		if (!testPattern.test(path)) return false;
		return applicationDomainEntries(
			path,
			readFileSync(join(root, path), "utf8"),
		).some((domain) => wanted.has(domain));
	});
}

export function selectionPaths(selected: Domain[], sub?: string) {
	return [
		...new Set(
			selected
				.flatMap(ownedPaths)
				.map((path) => (sub ? `${path}/subdomains/${sub}` : path)),
		),
	];
}

export const acceptanceFiles = [
	"judge",
	"frozen",
	"tester-parser",
	"runner",
].map((name) => `tests/acceptance/nl/${name}.test.ts`);
export const testPattern = /\.(test|spec)\.[cm]?[jt]sx?$/;
export type TestRunner = "bun" | "web" | "client" | "design-system";
export function runnerFor(path: string): TestRunner | undefined {
	if (
		/^(api\/|packages\/(coding-runner|dots-mcp)\/test\/)/.test(path) ||
		// artifact-ui's own module tests (pure logic; the views install jsdom themselves).
		/^packages\/artifact-ui\/src\/.*\.test\.tsx?$/.test(path) ||
		(path.startsWith("scripts/") &&
			/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) ||
		acceptanceFiles.includes(path)
	)
		return "bun";
	if (/^web\/src\/.*\.test\.tsx?$/.test(path)) return "web";
	if (/^client\/.*\.test\.ts$/.test(path)) return "client";
	if (/^packages\/design-system\/src\/.*\.test\.tsx?$/.test(path))
		return "design-system";
}
export function groupTests(files: string[]) {
	const groups: Record<TestRunner, string[]> = {
		bun: [],
		web: [],
		client: [],
		"design-system": [],
	};
	for (const path of [...new Set(files)].sort()) {
		const runner = runnerFor(path);
		if (!runner) throw new Error(`No non-browser test runner for ${path}`);
		groups[runner].push(path);
	}
	return groups;
}
export function testCommand(runner: TestRunner, files: string[]) {
	if (runner === "bun")
		return [process.execPath, "test", ...files.map((path) => `./${path}`)];
	if (runner === "design-system")
		return [
			process.execPath,
			"run",
			"--cwd",
			"packages/design-system",
			"test",
			...files.map((path) => path.replace(/^packages\/design-system\//, "")),
		];
	return [process.execPath, "x", "--no-install", "vitest", "run", ...files];
}
