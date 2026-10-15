import { expect, test } from "bun:test";
import { median, summarizeReports } from "./verification-metrics";
import type { VerificationReport } from "./verification-run";

function report(
	result: VerificationReport["result"],
	totalMs: number,
	platform = "darwin",
): VerificationReport {
	return {
		schemaVersion: 1,
		runId: `${result}-${totalMs}`,
		startedAt: "2026-10-15T00:00:00Z",
		scope: { all: true, selected: [] },
		baseCommit: "base",
		revision: "hash",
		runtime: {
			bun: "test",
			node: "test",
			platform,
			arch: "arm64",
			ci: false,
			runner: null,
		},
		result,
		totalMs,
		steps: [
			{ name: "design-system build", ms: 10, status: "pass" },
			{
				name: "bun tests",
				ms: totalMs - 10,
				status: result === "pass" ? "pass" : "fail",
			},
		],
		integrityErrors: [],
		build: { sharedOutput: true },
	};
}
test("metrics separate failures and environments from passing timing samples", () => {
	const summary = summarizeReports([
		report("pass", 100),
		report("pass", 200),
		report("fail", 1),
		report("invalidated", 300),
		report("pass", 500, "linux"),
	]);
	expect(summary.length).toBe(2);
	expect(summary[0]?.passingSamples).toBe(2);
	expect(summary[0]?.medianPassMs).toBe(150);
	expect(summary[0]?.results.fail).toBe(1);
	expect(summary[1]?.medianPassMs).toBe(500);
	expect(summary[0]?.splitComparison.samples[0]?.idealWallMs).toBe(100);
	expect(summary[0]?.splitComparison.samples[0]?.runnerSumMs).toBeGreaterThan(
		100,
	);
	expect(summary[0]?.splitComparison.excludes).toContain(
		"install/postinstall repeated per job",
	);
});
test("empty and failed cohorts never imply measured speed improvements", () => {
	expect(median([])).toBeNull();
	expect(median([30, 10, 20])).toBe(20);
	expect(summarizeReports([])).toEqual([]);
	const [summary] = summarizeReports([report("fail", 1)]);
	expect(summary?.medianPassMs).toBeNull();
	expect(summary?.splitComparison.samples).toEqual([]);
});
