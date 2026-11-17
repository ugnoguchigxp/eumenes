import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createReport } from "./verification-run";
import { integrationTestFiles, sourceFiles } from "./verification-selection";
import { testInventory } from "./test-inventory";
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
	expect(integrationTestFiles(root, ["pipelines"])).toEqual([
		"api/application/app-development/app-development.test.ts",
		"api/application/app-development/app-storage.test.ts",
		...pipelineTests,
		"api/application/pipelines/workflow-authoring.test.ts",
	]);
});

test("explicit integration ownership joins direct imports once and stays scoped", () => {
	const files = integrationTestFiles(root, ["pipelines", "queue", "pipelines"]);
	for (const file of pipelineTests)
		expect(files.filter((path) => path === file)).toHaveLength(1);
	expect(files).toContain("api/application/work/tasks-http.test.ts");
	for (const file of pipelineTests)
		expect(integrationTestFiles(root, ["queue"])).not.toContain(file);
});

test("collaboration verification reaches application cases composed through the host fixture", () => {
	const files = sourceFiles(root, "api/application/collaboration").filter(
		(path) => path.endsWith(".test.ts"),
	);
	expect(files.length).toBeGreaterThan(0);
	expect(integrationTestFiles(root, ["collaboration"])).toEqual(
		expect.arrayContaining(files),
	);
});

test("a parked checkout is left out and a new product test is kept", () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-inventory-"));
	temporary.push(dir);
	const write = (path: string, content = "export {}\n") => {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), content);
	};
	write("api/brand-new.test.ts");
	write("web/src/brand-new.test.tsx");
	write("client/brand-new.test.ts");
	write("packages/design-system/package.json");
	write("packages/design-system/api/ignored.ts");
	write("packages/design-system/web/ignored.ts");
	write("packages/design-system/src/brand-new.test.tsx");
	write("artifacts/brand-new.test.ts");
	write("artifacts/old-copy/package.json", '{"name":"eumenes"}');
	write("artifacts/old-copy/api/old.test.ts");
	write("artifacts/old-copy/web/src/old.test.tsx");
	write("artifacts/product/package.json", '{"name":"product-fixtures"}');
	write("artifacts/product/api/contract.test.ts");
	write("artifacts/product/web/src/contract.test.tsx");
	const files = sourceFiles(dir, "");
	expect(files).toContain("api/brand-new.test.ts");
	expect(files).toContain("web/src/brand-new.test.tsx");
	expect(files).toContain("client/brand-new.test.ts");
	expect(files).toContain("packages/design-system/src/brand-new.test.tsx");
	expect(files).toContain("artifacts/brand-new.test.ts");
	expect(files).toContain("artifacts/product/api/contract.test.ts");
	expect(files).toContain("artifacts/product/web/src/contract.test.tsx");
	expect(files.some((path) => path.startsWith("artifacts/old-copy/"))).toBe(
		false,
	);
	const product = sourceFiles(root, "");
	expect(
		product.some(
			(path) =>
				path.startsWith("artifacts/pursuit-") &&
				/\.(test|spec)\.[cm]?[jt]sx?$/.test(path),
		),
	).toBe(false);
	expect(product.some((path) => path.includes("/snapshot/"))).toBe(false);
	expect(product).toContain("scripts/verification-selection.test.ts");
	const inventory = testInventory(root);
	const listed = inventory.projects.flatMap((project) => project.files ?? []);
	expect(listed.some((path) => path.startsWith("artifacts/"))).toBe(false);
	expect(listed).toContain("api/domains/dialogue/test/pursuit-result.test.ts");
	expect(listed).toContain("scripts/verification-selection.test.ts");
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
