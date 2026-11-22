import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	allSourceFiles,
	checkBoundaries,
	unusedDependencies,
} from "./boundaries";
import { checkFixedNames } from "./fixed-names";
import {
	parseSelection,
	sourceFiles,
	staticSelectionPaths,
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

export type GuardStepResult = {
	name: string;
	ms: number;
	failing: Finding[];
	outside: Finding[];
};

export function parseGuardScope(raw: string[]): StaticScope {
	const cleaned = raw.filter((arg) => arg !== "--");
	if (cleaned.length === 0) {
		return { all: true, domains: [], paths: [] };
	}
	const selection = parseSelection(cleaned);
	return {
		all: selection.all,
		domains: selection.selected,
		paths: selection.all ? [] : staticSelectionPaths(selection.selected),
	};
}

function runTool(
	root: string,
	args: string[],
	parse: (output: string, exitCode: number) => Finding[],
): Finding[] {
	const result = Bun.spawnSync([process.execPath, ...args], { cwd: root });
	const output = `${result.stdout.toString()}${result.stderr.toString()}`;
	const findings = parse(output, result.exitCode);
	if (result.exitCode === 0 || findings.length) return findings;
	const tail = output.trim().split("\n").slice(-15).join("\n");
	return [{ text: `${args.join(" ")} failed (${result.exitCode})\n${tail}` }];
}

export function runGuards(root: string, scope: StaticScope): GuardStepResult[] {
	const steps: Array<{ name: string; run: () => Finding[] }> = [
		{
			name: "boundaries",
			run: () => {
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
			},
		},
		{
			name: "sql-boundaries",
			run: () =>
				runTool(root, ["scripts/sql-boundaries.ts"], sqlBoundaryFindings),
		},
		{
			name: "size-budget",
			run: () => runTool(root, ["scripts/size-budget.ts"], sizeBudgetFindings),
		},
		{
			name: "fixed-names",
			run: () => checkFixedNames(root),
		},
		{
			name: "domain-docs",
			run: () =>
				runTool(root, ["scripts/domain-docs.ts", "--check"], (output, code) =>
					code === 0 ? [] : [{ text: output.trim(), path: "docs/domains.md" }],
				),
		},
		{
			name: "format",
			run: () => runTool(root, ["run", "format:check"], formatFindings),
		},
		{
			name: "lint",
			run: () =>
				runTool(root, ["run", "lint", "--format", "unix"], lintFindings),
		},
		{
			name: "system-context",
			run: () =>
				runTool(root, ["run", "context:check"], (output) =>
					contextFindings(output, root),
				),
		},
		{
			name: "typecheck",
			run: () =>
				runTool(root, ["check", "--no-pretty", "--all"], typecheckFindings),
		},
	];

	return steps.map((step) => {
		const started = performance.now();
		const { failing, outside } = partition(step.run(), scope);
		return {
			name: step.name,
			ms: Math.round(performance.now() - started),
			failing,
			outside,
		};
	});
}

if (import.meta.main) {
	const root = resolve(import.meta.dir, "..");
	let scope: StaticScope;
	try {
		scope = parseGuardScope(process.argv.slice(2));
	} catch (error) {
		console.error(String(error));
		process.exit(2);
	}
	const started = performance.now();
	const scopeLabel = scope.all ? "all" : scope.domains.join(",");
	console.log(`[check:guards] scope=${scopeLabel}`);
	const results = runGuards(root, scope);
	let totalFail = 0;
	let totalOutside = 0;
	for (const r of results) {
		totalFail += r.failing.length;
		totalOutside += r.outside.length;
		const status = r.failing.length ? "FAIL" : "PASS";
		const warnNote = r.outside.length
			? ` (${r.outside.length} outside-scope warnings)`
			: "";
		console.log(
			`  [${status}] ${r.name.padEnd(16)} ${String(r.ms).padStart(5)}ms${warnNote}`,
		);
		for (const f of r.failing.slice(0, 10)) console.error(`    ${f.text}`);
		if (r.failing.length > 10)
			console.error(`    ... and ${r.failing.length - 10} more`);
	}
	if (existsSync(join(root, "dist-web/index.html"))) {
		const bundle = Bun.spawnSync(
			[process.execPath, "scripts/bundle-budget.ts"],
			{ cwd: root },
		);
		const summary = `${bundle.stdout.toString()}${bundle.stderr.toString()}`
			.trim()
			.split("\n")[0];
		console.log(
			`  [INFO] bundle-budget    (dist-web present) ${summary ?? ""}`,
		);
	}
	console.log(
		`[check:guards] done in ${Math.round(performance.now() - started)}ms: failing=${totalFail}, outsideWarnings=${totalOutside}`,
	);
	if (totalFail > 0) process.exit(1);
}
