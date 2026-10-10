import {
	closeSync,
	constants,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { flock } from "../api/infrastructure/flock";
import {
	allSourceFiles,
	checkBoundaries,
	unusedDependencies,
} from "./boundaries";
import { closure, type Domain, domains, isDomain, ownedPaths } from "./domains";

const args = process.argv.slice(2).filter((x) => x !== "--");
const all = args.includes("--all");
const index = args.indexOf("--domain");
const requested = index >= 0 ? args[index + 1] : undefined;
if (args.includes("--affected")) {
	console.error("--affected is planned after MVP; select --domain or --all");
	process.exit(2);
}
if ((!all && !requested) || (requested && !isDomain(requested))) {
	console.error(`Use --domain <${Object.keys(domains).join("|")}> or --all`);
	process.exit(2);
}
const selected = all
	? (Object.keys(domains) as Domain[])
	: [requested as Domain];
const root = resolve(import.meta.dir, "..");
const reports = join(root, "verification-reports");
mkdirSync(reports, { recursive: true });
const fd = openSync(
	join(reports, "verify.lock"),
	constants.O_CREAT | constants.O_RDWR,
	0o600,
);
if (flock(fd, 6) !== 0) {
	console.error("Another verification is running");
	closeSync(fd);
	process.exit(3);
}
function files(path: string): string[] {
	try {
		return readdirSync(path).flatMap((name) => {
			if (
				[
					"node_modules",
					"dist-web",
					"verification-reports",
					".git",
					"test-results",
					"playwright-report",
				].includes(name)
			)
				return [];
			const file = join(path, name);
			return statSync(file).isDirectory() ? files(file) : [file];
		});
	} catch {
		return [];
	}
}
function sourceFiles() {
	return files(root)
		.filter(
			(path) =>
				!path.includes("node_modules/") &&
				!path.includes("dist-web/") &&
				!path.includes("verification-reports/") &&
				!path.includes("test-results/") &&
				!path.includes("playwright-report/") &&
				!path.includes(".git/") &&
				(/\.(ts|tsx|css|json)$/.test(path) || path.endsWith("bun.lock")),
		)
		.sort();
}
async function revision() {
	const hash = new Bun.CryptoHasher("sha256");
	for (const file of sourceFiles()) {
		hash.update(file.slice(root.length));
		hash.update(readFileSync(file));
	}
	return hash.digest("hex");
}
const startHash = await revision();
const started = performance.now();
const steps: Array<{ name: string; ms: number; result: string }> = [];
async function run(name: string, command: string[]) {
	const start = performance.now();
	console.log(`[verify] ${name}: ${command.join(" ")}`);
	const child = Bun.spawn(command, {
		cwd: root,
		stdout: "inherit",
		stderr: "inherit",
	});
	const code = await child.exited;
	steps.push({
		name,
		ms: Math.round(performance.now() - start),
		result: code === 0 ? "pass" : `exit ${code}`,
	});
	if (code !== 0) throw new Error(`${name} failed (${code})`);
}
try {
	const paths = [...new Set(selected.flatMap(ownedPaths))].map((path) =>
		resolve(root, path),
	);
	const tsFiles = paths.flatMap(files).filter((file) => /\.tsx?$/.test(file));
	const errors = checkBoundaries(
		(all
			? files(join(root, "api")).concat(
					files(join(root, "web/src")),
					files(join(root, "client")),
					files(join(root, "cli")),
					files(join(root, "packages/artifact-ui/src")),
					files(join(root, "packages/coding-runner/src")),
					files(join(root, "packages/coding-runner/test")),
				)
			: tsFiles
		)
			.filter((file) => /\.tsx?$/.test(file))
			.map((file) => file.slice(root.length + 1)),
	);
	if (all) {
		// Declared-but-unused dependencies need the whole tree to be decidable.
		errors.push(...unusedDependencies(allSourceFiles()));
	}
	if (errors.length) throw new Error(errors.join("\n"));
	// Typecheck needs the production closure (api + web); tests add the test-only edges.
	const dependencySet = [
		...new Set(
			selected.flatMap((d) => [...closure(d, "api"), ...closure(d, "web")]),
		),
	];
	const testDependencySet = [
		...new Set(selected.flatMap((d) => closure(d, "test"))),
	];
	console.log(
		`[verify] selected=${selected.join(",")} dependencyClosure=${dependencySet.join(",")} testClosure=${testDependencySet.join(",")}`,
	);
	const checkPaths = all
		? ["."]
		: paths.map((path) => path.slice(root.length + 1));
	await run("size-budget", [
		process.execPath,
		"scripts/size-budget.ts",
		...(all ? [] : checkPaths),
	]);
	if (all)
		await run("sql-boundaries", [
			process.execPath,
			"scripts/sql-boundaries.ts",
		]);
	if (all)
		await run("domain-docs", [
			process.execPath,
			"scripts/domain-docs.ts",
			"--check",
		]);
	await run("format", [process.execPath, "run", "format:check", ...checkPaths]);
	await run("lint", [process.execPath, "run", "lint", ...checkPaths]);
	if (all) await run("typecheck", [process.execPath, "run", "typecheck"]);
	else {
		const config = join(reports, "tsconfig.selected.json");
		writeFileSync(
			config,
			JSON.stringify(
				{
					extends: "../tsconfig.json",
					include: tsFiles
						.map((file) => file.slice(root.length + 1))
						.map((file) => `../${file}`),
					compilerOptions: { noEmit: true },
				},
				null,
				2,
			),
		);
		await run("typecheck", [process.execPath, "x", "tsc", "-p", config]);
		const list = Bun.spawnSync(
			[process.execPath, "x", "tsc", "-p", config, "--listFilesOnly"],
			{ cwd: root },
		);
		const used = list.stdout
			.toString()
			.split("\n")
			.filter((x) => x.startsWith(root) && !x.includes("node_modules/"))
			.map((x) => x.slice(root.length + 1));
		console.log(
			`[verify] TypeScript workspace closure: ${used.length} files; ${[...new Set(used.map((x) => x.split("/").slice(0, 3).join("/")))].join(", ")}`,
		);
		rmSync(config);
	}
	if (all) {
		await run("tests", [
			process.execPath,
			"test",
			"api",
			"packages/coding-runner/test",
			"scripts",
		]);
		await run("web tests", [process.execPath, "x", "vitest", "run", "web"]);
		await run("client tests", [
			process.execPath,
			"x",
			"vitest",
			"run",
			"client",
		]);
		await run("design-system typecheck", [
			process.execPath,
			"run",
			"--cwd",
			"packages/design-system",
			"typecheck",
		]);
		await run("design-system tests", [
			process.execPath,
			"run",
			"--cwd",
			"packages/design-system",
			"test",
		]);
		await run("web build", [process.execPath, "run", "build:web"]);
		await run("browser fixture", [process.execPath, "x", "playwright", "test"]);
	} else
		await run("domain tests", [
			process.execPath,
			"run",
			"test:domain",
			"--",
			selected[0] ?? "",
		]);
	if ((await revision()) !== startHash)
		throw new Error("source changed during verification");
	const report = {
		selected,
		dependencySet,
		testDependencySet,
		revision: startHash,
		steps,
		totalMs: Math.round(performance.now() - started),
		result: "pass",
	};
	writeFileSync(join(reports, "latest.json"), JSON.stringify(report, null, 2));
	console.log(`[verify] passed ${report.totalMs} ms`);
} catch (error) {
	const report = {
		selected,
		revision: startHash,
		steps,
		totalMs: Math.round(performance.now() - started),
		result: "fail",
		error: String(error),
	};
	writeFileSync(join(reports, "latest.json"), JSON.stringify(report, null, 2));
	console.error(error);
	process.exitCode = 1;
} finally {
	flock(fd, 8);
	closeSync(fd);
}
