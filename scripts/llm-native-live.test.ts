import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("live startup failure still produces a safe evaluation report and stops after two runs", async () => {
	const out = mkdtempSync(join(tmpdir(), "llm-live-report-"));
	try {
		const child = Bun.spawn(
			[
				process.execPath,
				"scripts/llm-native-live.ts",
				"--suite",
				"voice-language",
				"--out",
				out,
			],
			{
				cwd: resolve(import.meta.dir, ".."),
				env: {
					...process.env,
					EUMENES_LIVE_LLM_NATIVE: "1",
					EUMENES_DB: join(out, "missing.sqlite3"),
				},
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		expect(await child.exited).toBe(1);
		const report = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
		expect(report.accepted).toBe(false);
		expect(report.results).toHaveLength(2);
		for (const result of report.results)
			expect(result).toMatchObject({
				status: "failed",
				safeCode: "live_evaluation_failed",
				semanticChecks: "unchecked",
			});
		expect(report.results[0].caseId).toBe(report.results[1].caseId);
		expect(readFileSync(join(out, "summary.md"), "utf8")).toContain(
			"Acceptance: incomplete",
		);
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
});
