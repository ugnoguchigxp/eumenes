import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Domain, domains, ownedPaths } from "./domains";
import type { VerificationReport } from "./verification-run";

export function median(values: number[]) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? sorted[middle]!
		: (sorted[middle - 1]! + sorted[middle]!) / 2;
}
export function summarizeReports(reports: VerificationReport[]) {
	const cohorts = new Map<string, VerificationReport[]>();
	for (const report of reports) {
		const key = JSON.stringify({
			all: report.scope.all,
			selected: report.scope.all ? [] : [...report.scope.selected].sort(),
			runtime: report.runtime,
		});
		const group = cohorts.get(key) ?? [];
		group.push(report);
		cohorts.set(key, group);
	}
	return [...cohorts].map(([key, runs]) => {
		const passed = runs.filter(
			(report) =>
				report.result === "pass" &&
				report.steps.every((step) => step.status === "pass"),
		);
		const steps = [
			...new Set(
				runs.flatMap((report) => report.steps.map((step) => step.name)),
			),
		].map((name) => ({
			name,
			completedSamples: runs.filter((report) =>
				report.steps.some(
					(step) => step.name === name && step.status === "pass",
				),
			).length,
			medianMsInPassingRuns: median(
				passed.flatMap((report) =>
					report.steps
						.filter((step) => step.name === name)
						.map((step) => step.ms),
				),
			),
		}));
		// Only complete --all results support this lower-bound comparison. No hosted CI claims.
		const comparisons = passed
			.filter((report) => report.scope.all)
			.map((report) => {
				const time = (name: string) =>
					report.steps.find((step) => step.name === name)?.ms ?? 0;
				const build = time("design-system build");
				const staticNames = [
					"inventory",
					"boundaries",
					"size-budget",
					"sql-boundaries",
					"domain-docs",
					"format",
					"lint",
					"design-system typecheck",
					"typecheck",
				];
				const jobs = {
					static: staticNames.reduce((sum, name) => sum + time(name), build),
					backend: build + time("bun tests"),
					webAndClient: build + time("web tests") + time("client tests"),
					designSystem: build + time("design-system tests"),
					webBuild: build + time("web build"),
				};
				return {
					runId: report.runId,
					jobsMs: jobs,
					idealWallMs: Math.max(...Object.values(jobs)),
					runnerSumMs: Object.values(jobs).reduce(
						(sum, value) => sum + value,
						0,
					),
				};
			});
		return {
			cohort: JSON.parse(key),
			samples: runs.length,
			passingSamples: passed.length,
			results: Object.fromEntries(
				["pass", "fail", "interrupted", "invalidated", "running"].map(
					(result) => [
						result,
						runs.filter((run) => run.result === result).length,
					],
				),
			),
			medianPassMs: median(passed.map((report) => report.totalMs)),
			steps,
			splitComparison: {
				kind: "theoretical-lower-bound",
				excludes: [
					"checkout",
					"install/postinstall repeated per job",
					"scheduling",
					"artifact transfer",
					"aggregation",
				],
				samples: comparisons,
			},
		};
	});
}
function git(root: string, args: string[]) {
	const result = Bun.spawnSync(["git", ...args], { cwd: root });
	if (result.exitCode !== 0)
		throw new Error(`Git measurement failed: ${args[0]}`);
	return result.stdout.toString();
}
export function historyCoverage(root: string, count = 60) {
	const commits = git(root, [
		"rev-list",
		"--first-parent",
		`--max-count=${count}`,
		"HEAD",
	])
		.trim()
		.split("\n");
	const owners = (Object.keys(domains) as Domain[]).flatMap((domain) =>
		ownedPaths(domain).map((path) => ({ domain, path })),
	);
	const work = commits.map((commit) => {
		const paths = git(root, [
			"diff-tree",
			"--root",
			"--no-commit-id",
			"--name-only",
			"-r",
			"-z",
			commit,
		])
			.split("\0")
			.filter(Boolean);
		const inputs = paths.filter(
			(path) => !/^(docs|spec)\//.test(path) && !/\.mdx?$/.test(path),
		);
		const owned = inputs.map((path) => ({
			path,
			owners: owners
				.filter(
					(owner) => path === owner.path || path.startsWith(`${owner.path}/`),
				)
				.map((owner) => owner.domain),
		}));
		return {
			commit,
			inputCount: inputs.length,
			domains: [...new Set(owned.flatMap((item) => item.owners))],
			unowned: owned
				.filter((item) => !item.owners.length)
				.map((item) => item.path),
		};
	});
	const code = work.filter((item) => item.inputCount > 0);
	return {
		head: commits[0],
		oldest: commits.at(-1),
		requested: count,
		sampled: commits.length,
		interpretation:
			"Exploratory current-graph ownership only; all tracked non-document paths. Not affected coverage, local work units, or a speedup estimate. Stage C requires old/new graph and push-range evaluation.",
		codeCommits: code.length,
		ownedOnly: code.filter((item) => !item.unowned.length).length,
		singleDomainOnly: code.filter(
			(item) => !item.unowned.length && item.domains.length === 1,
		).length,
		commits: work,
	};
}
if (import.meta.main) {
	const root = resolve(import.meta.dir, "..");
	const args = process.argv.slice(2);
	if (args.length > 1 || args[0]?.startsWith("--"))
		throw new Error(
			"Usage: bun scripts/verification-metrics.ts [reports-directory]",
		);
	const directory = resolve(
		args[0] ?? join(root, "verification-reports"),
		"runs",
	);
	const reports = existsSync(directory)
		? readdirSync(directory).flatMap((run) => {
				const path = join(directory, run, "report.json");
				if (!existsSync(path)) return [];
				const report = JSON.parse(readFileSync(path, "utf8"));
				if (report.schemaVersion !== 1)
					throw new Error(`Unsupported report schema: ${path}`);
				return [report as VerificationReport];
			})
		: [];
	console.log(
		JSON.stringify(
			{
				schemaVersion: 1,
				generatedAt: new Date().toISOString(),
				history: historyCoverage(root),
				measurements: summarizeReports(reports),
				ciPreparation: existsSync(join(directory, "..", "preparation.json"))
					? JSON.parse(
							readFileSync(join(directory, "..", "preparation.json"), "utf8"),
						)
					: null,
				decision:
					"Keep affected selection deferred until comparable passing samples and maintenance/CI costs are available; unverified push before must use full non-browser verification.",
			},
			null,
			2,
		),
	);
}
