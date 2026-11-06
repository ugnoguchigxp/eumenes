import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createReport } from "./verification-run";
import { integrationTestFiles } from "./verification-selection";
import { verificationPlan } from "./verify";

const root = resolve(import.meta.dir, "..");
const pipelineTests = [
	"api/application/pipelines/pipeline-execution.test.ts",
	"api/application/pipelines/vendor.test.ts",
];
const temporary: string[] = [];
afterEach(() => {
	for (const dir of temporary.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

test("pipeline verification includes its fixture-composed execution and adopted package", () => {
	expect(integrationTestFiles(root, ["pipelines"])).toEqual(pipelineTests);
});

test("explicit integration ownership joins direct imports once and stays scoped", () => {
	const files = integrationTestFiles(root, ["pipelines", "queue", "pipelines"]);
	for (const file of pipelineTests)
		expect(files.filter((path) => path === file)).toHaveLength(1);
	expect(files).toContain("api/application/work/tasks-http.test.ts");
	for (const file of pipelineTests)
		expect(integrationTestFiles(root, ["queue"])).not.toContain(file);
});

test("a missing declared integration test fails instead of silently shrinking verification", () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-selection-"));
	temporary.push(dir);
	expect(() => integrationTestFiles(dir, ["pipelines"])).toThrow(
		"integration_test_missing:api/application/pipelines/pipeline-execution.test.ts",
	);
});

test("the pipeline verify plan executes the declared integrations", () => {
	const report = createReport(root, { all: false, selected: ["pipelines"] });
	const tests = verificationPlan(root, root, report).find(
		(step) => step.name === "bun tests",
	);
	expect(tests).toBeDefined();
	for (const file of pipelineTests)
		expect(tests!.command).toContain(`./${file}`);
	expect(tests!.command).not.toContain(
		"./api/application/work/tasks-http.test.ts",
	);
});
