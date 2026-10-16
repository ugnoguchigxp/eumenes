import {
	closeSync,
	constants,
	mkdirSync,
	openSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { flock } from "../api/infrastructure/flock";
import {
	allSourceFiles,
	checkBoundaries,
	unusedDependencies,
} from "./boundaries";
import { closure } from "./domains";
import { testInventory } from "./test-inventory";
import {
	createReport,
	distRevision,
	executeVerification,
	type VerificationReport,
	type VerificationStep,
} from "./verification-run";
import {
	groupTests,
	parseSelection,
	selectionPaths,
	sourceFiles,
	testCommand,
	testPattern,
	type TestRunner,
} from "./verification-selection";

export function verificationPlan(
	root: string,
	directory: string,
	report: VerificationReport,
): VerificationStep[] {
	const { all, selected } = report.scope;
	const selection = parseSelection(
		all ? ["--all"] : selected.flatMap((domain) => ["--domain", domain]),
	);
	const paths = selectionPaths(selection.selected);
	const tsFiles = [
		...new Set(paths.flatMap((path) => sourceFiles(root, path))),
	].filter((path) => /\.tsx?$/.test(path));
	const checkPaths = all ? ["."] : paths;
	const plan: VerificationStep[] = [];
	const command = (name: string, args: string[]) =>
		plan.push({ name, command: [process.execPath, ...args] });
	plan.push({
		name: "inventory",
		action() {
			const inventory = testInventory(root);
			writeFileSync(
				join(directory, "inventory.json"),
				JSON.stringify(inventory, null, 2) + "\n",
			);
		},
	});
	plan.push({
		name: "boundaries",
		action() {
			const files = all
				? [
						"api",
						"web/src",
						"client",
						"cli",
						"packages/artifact-ui/src",
						"packages/coding-runner/src",
						"packages/coding-runner/test",
					].flatMap((path) => sourceFiles(root, path))
				: tsFiles;
			const errors = checkBoundaries(
				files.filter((path) => /\.tsx?$/.test(path)),
			);
			if (all) errors.push(...unusedDependencies(allSourceFiles()));
			if (errors.length) throw new Error(errors.join("\n"));
		},
	});
	command("system-context", ["run", "context:check"]);
	command("size-budget", [
		"scripts/size-budget.ts",
		...(all ? [] : checkPaths),
	]);
	if (all) {
		command("sql-boundaries", ["scripts/sql-boundaries.ts"]);
		command("domain-docs", ["scripts/domain-docs.ts", "--check"]);
	}
	command("format", ["run", "format:check", ...checkPaths]);
	command("lint", ["run", "lint", ...checkPaths]);
	// Regular check includes stories/tests; build's tsconfig deliberately excludes them.
	command("design-system typecheck", [
		"run",
		"--cwd",
		"packages/design-system",
		"typecheck",
	]);
	plan.push({
		name: "design-system build",
		command: [
			process.execPath,
			"run",
			"--cwd",
			"packages/design-system",
			"build",
		],
		action() {
			report.build.inputRevision = report.revision;
			report.build.distAfterBuild = distRevision(
				join(root, "packages/design-system/dist"),
			);
		},
	});
	if (all) command("typecheck", ["run", "typecheck"]);
	else {
		const config = join(directory, "tsconfig.selected.json");
		plan.push({
			name: "typecheck configuration",
			action() {
				writeFileSync(
					config,
					JSON.stringify(
						{
							extends: join(root, "tsconfig.json"),
							include: tsFiles
								.filter((path) => !path.startsWith("packages/design-system/"))
								.map((path) => join(root, path)),
							compilerOptions: { noEmit: true },
						},
						null,
						2,
					),
				);
			},
		});
		command("typecheck", ["check", "-p", config]);
		plan.push({
			name: "typecheck closure",
			action() {
				const list = Bun.spawnSync(
					[process.execPath, "check", "-p", config, "--listFilesOnly"],
					{ cwd: root },
				);
				if (list.exitCode !== 0)
					throw new Error(`typecheck file listing failed (${list.exitCode})`);
				const used = list.stdout
					.toString()
					.split("\n")
					.filter(
						(file) => file.startsWith(root) && !file.includes("node_modules/"),
					)
					.map((file) => file.slice(root.length + 1));
				writeFileSync(
					join(directory, "typecheck-files.json"),
					JSON.stringify(used, null, 2),
				);
				console.log(
					`[verify] TypeScript workspace closure: ${used.length} files`,
				);
			},
		});
	}
	const tests = all
		? sourceFiles(root, "").filter(
				(path) =>
					testPattern.test(path) &&
					!path.startsWith("spec/verification/") &&
					!path.startsWith("tests/browser/") &&
					path !== "tests/acceptance/nl/driver.test.ts",
			)
		: paths
				.flatMap((path) => sourceFiles(root, path))
				.filter((path) => testPattern.test(path));
	const groups = groupTests(tests);
	if (!tests.length)
		plan.push({
			name: "tests",
			action() {
				throw new Error("No tests selected");
			},
		});
	for (const runner of Object.keys(groups) as TestRunner[]) {
		if (groups[runner].length)
			plan.push({
				name: `${runner} tests`,
				command: testCommand(runner, groups[runner]),
			});
	}
	// DS was already built before every consumer; do not rebuild shared dist here.
	if (all) {
		command("web build", ["x", "--no-install", "vite", "build"]);
		command("bundle-budget", ["scripts/bundle-budget.ts"]);
	}
	return plan;
}

if (import.meta.main) {
	let selection: ReturnType<typeof parseSelection>;
	try {
		selection = parseSelection(process.argv.slice(2));
	} catch (error) {
		console.error(String(error));
		process.exit(2);
	}
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
	let directory: string | undefined;
	try {
		const report = createReport(root, {
			all: selection.all,
			selected: selection.selected,
		});
		directory = join(reports, "runs", report.runId);
		mkdirSync(directory, { recursive: true });
		const dependencySet = [
			...new Set(
				selection.selected.flatMap((domain) => [
					...closure(domain, "api"),
					...closure(domain, "web"),
				]),
			),
		];
		const testDependencySet = [
			...new Set(
				selection.selected.flatMap((domain) => closure(domain, "test")),
			),
		];
		writeFileSync(
			join(directory, "selection.json"),
			JSON.stringify(
				{ selected: selection.selected, dependencySet, testDependencySet },
				null,
				2,
			),
		);
		console.log(
			`[verify] selected=${selection.selected.join(",")} dependencyClosure=${dependencySet.join(",")}`,
		);
		console.log(
			"[verify] Shared DesignSystem dist: do not overlap dev, browser tests or other builds; endpoint hashes cannot detect change-and-restore.",
		);
		let plan: VerificationStep[];
		try {
			plan = verificationPlan(root, directory, report);
		} catch (error) {
			plan = [
				{
					name: "plan",
					action() {
						throw error;
					},
				},
			];
		}
		process.exitCode = await executeVerification(root, reports, report, plan);
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
	} finally {
		if (directory)
			rmSync(join(directory, "tsconfig.selected.json"), { force: true });
		flock(fd, 8);
		closeSync(fd);
	}
}
