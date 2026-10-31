import {
	closeSync,
	constants,
	mkdirSync,
	openSync,
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
	integrationTestFiles,
	selectionPaths,
	sourceFiles,
	testCommand,
	testPattern,
	type TestRunner,
} from "./verification-selection";
import {
	boundaryFindings,
	contextFindings,
	formatFindings,
	lintFindings,
	partition,
	sizeBudgetFindings,
	sqlBoundaryFindings,
	typecheckFindings,
	type Finding,
	type StaticScope,
} from "./verification-static";

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
	const scope: StaticScope = { all, domains: selection.selected, paths };
	const plan: VerificationStep[] = [];
	const command = (name: string, args: string[]) =>
		plan.push({ name, command: [process.execPath, ...args] });
	/**
	 * A static check always covers the whole repository. Findings of the selection fail the step;
	 * the rest are warnings, so parallel work elsewhere does not block this run but stays visible.
	 */
	const check = (name: string, run: () => Finding[]) =>
		plan.push({
			name,
			action() {
				const { failing, outside } = partition(run(), scope);
				if (failing.length)
					throw new Error(failing.map((finding) => finding.text).join("\n"));
				return { warnings: outside.map((finding) => finding.text) };
			},
		});
	/** Runs a tool over the repository; a failure with no recognized finding fails as a whole. */
	const tool =
		(args: string[], parse: (output: string, exitCode: number) => Finding[]) =>
		(): Finding[] => {
			const result = Bun.spawnSync([process.execPath, ...args], { cwd: root });
			const output = `${result.stdout.toString()}${result.stderr.toString()}`;
			const findings = parse(output, result.exitCode);
			if (result.exitCode === 0 || findings.length) return findings;
			const tail = output.trim().split("\n").slice(-20).join("\n");
			return [
				{ text: `${args.join(" ")} failed (${result.exitCode})\n${tail}` },
			];
		};
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
	check("boundaries", () => {
		const files = [
			"api",
			"web/src",
			"client",
			"cli",
			"packages/artifact-ui/src",
			"packages/coding-runner/src",
			"packages/coding-runner/test",
		]
			.flatMap((path) => sourceFiles(root, path))
			.filter((path) => /\.tsx?$/.test(path));
		return boundaryFindings([
			...checkBoundaries(files),
			...unusedDependencies(allSourceFiles()),
		]);
	});
	check(
		"system-context",
		tool(["run", "context:check"], (output) => contextFindings(output, root)),
	);
	check("size-budget", tool(["scripts/size-budget.ts"], sizeBudgetFindings));
	check(
		"sql-boundaries",
		tool(["scripts/sql-boundaries.ts"], sqlBoundaryFindings),
	);
	// The domain table is generated for the whole repository; it belongs to no domain.
	check(
		"domain-docs",
		tool(["scripts/domain-docs.ts", "--check"], (output, exitCode) =>
			exitCode === 0 ? [] : [{ text: output.trim(), path: "docs/domains.md" }],
		),
	);
	check("format", tool(["run", "format:check"], formatFindings));
	check("lint", tool(["run", "lint", "--format", "unix"], lintFindings));
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
	check(
		"typecheck",
		tool(["check", "--no-pretty", "--all"], typecheckFindings),
	);
	const tests = all
		? sourceFiles(root, "").filter(
				(path) =>
					testPattern.test(path) &&
					!path.startsWith("spec/verification/") &&
					!path.startsWith("tests/browser/") &&
					path !== "tests/acceptance/nl/driver.test.ts",
			)
		: [
				...paths
					.flatMap((path) => sourceFiles(root, path))
					.filter((path) => testPattern.test(path)),
				...integrationTestFiles(root, selection.selected),
			];
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
		flock(fd, 8);
		closeSync(fd);
	}
}
