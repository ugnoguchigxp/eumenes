import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "@typescript/typescript6";
import {
	acceptanceFiles,
	runnerFor,
	sourceFiles,
	testPattern,
} from "./verification-selection";

// Generated tests have no .test file: inventory runner projects as well as sources.
export function configuredProjects(source: string): string[] {
	const file = ts.createSourceFile(
		"vite.config.ts",
		source,
		ts.ScriptTarget.Latest,
		true,
	);
	const names: string[] = [];
	function visit(node: ts.Node) {
		if (
			ts.isPropertyAssignment(node) &&
			node.name.getText(file) === "projects" &&
			ts.isArrayLiteralExpression(node.initializer)
		) {
			for (const project of node.initializer.elements) {
				if (!ts.isObjectLiteralExpression(project))
					throw new Error("Inventory requires explicit Vitest projects");
				const test = project.properties.find(
					(p) => ts.isPropertyAssignment(p) && p.name.getText(file) === "test",
				);
				const name =
					test &&
					ts.isPropertyAssignment(test) &&
					ts.isObjectLiteralExpression(test.initializer)
						? test.initializer.properties.find(
								(p) =>
									ts.isPropertyAssignment(p) && p.name.getText(file) === "name",
							)
						: undefined;
				if (
					!name ||
					!ts.isPropertyAssignment(name) ||
					!ts.isStringLiteral(name.initializer)
				)
					throw new Error("Inventory requires named Vitest projects");
				names.push(name.initializer.text);
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(file);
	return names.sort();
}
function configuredStringArrays(source: string, property: string) {
	const file = ts.createSourceFile(
		"config.ts",
		source,
		ts.ScriptTarget.Latest,
		true,
	);
	const values: string[][] = [];
	function visit(node: ts.Node) {
		if (ts.isPropertyAssignment(node) && node.name.getText(file) === property) {
			if (
				!ts.isArrayLiteralExpression(node.initializer) ||
				!node.initializer.elements.every(ts.isStringLiteral)
			)
				throw new Error(`Inventory requires static ${property} patterns`);
			values.push(
				node.initializer.elements.map(
					(entry) => (entry as ts.StringLiteral).text,
				),
			);
		}
		ts.forEachChild(node, visit);
	}
	visit(file);
	return values;
}
function checkRunnerPatterns(root: string) {
	const rootConfig = readFileSync(join(root, "vitest.config.ts"), "utf8");
	if (configuredProjects(rootConfig).length)
		throw new Error("Update inventory for root Vitest projects");
	for (const [path, property, expected] of [
		[
			"vitest.config.ts",
			"include",
			[["web/src/**/*.test.{ts,tsx}", "client/**/*.test.ts"]],
		],
		[
			"packages/design-system/vite.config.ts",
			"include",
			[["src"], ["src/**/*.test.ts", "src/**/*.test.tsx"]],
		],
		[
			"packages/design-system/.storybook/main.ts",
			"stories",
			[["../src/**/*.stories.@(js|jsx|mjs|ts|tsx)"]],
		],
	] as const) {
		const actual = configuredStringArrays(
			readFileSync(join(root, path), "utf8"),
			property,
		);
		if (JSON.stringify(actual) !== JSON.stringify(expected))
			throw new Error(`Update inventory for runner patterns in ${path}`);
	}
}
export function testInventory(root: string) {
	checkRunnerPatterns(root);
	const files = sourceFiles(root, "").filter(
		(path) => !path.startsWith("spec/verification/"),
	);
	const tests = files.filter((path) => testPattern.test(path));
	const projects = configuredProjects(
		readFileSync(join(root, "packages/design-system/vite.config.ts"), "utf8"),
	);
	if (projects.join(",") !== "storybook,unit")
		throw new Error(
			`Update test inventory for DS projects: ${projects.join(",")}`,
		);
	const excluded = tests
		.filter((path) => !runnerFor(path))
		.map((path) => ({
			path,
			reason:
				path.startsWith("tests/browser/") ||
				path === "tests/acceptance/nl/driver.test.ts"
					? "Browser test: excluded from verify:all by AGENTS.md; run with an explicit file"
					: undefined,
		}));
	const unknown = excluded.filter((item) => !item.reason);
	if (unknown.length)
		throw new Error(
			`Tests without execution route or exclusion: ${unknown.map((item) => item.path).join(", ")}`,
		);
	for (const path of acceptanceFiles)
		if (!tests.includes(path))
			throw new Error(`Missing acceptance test: ${path}`);
	return {
		schemaVersion: 1,
		fileCount: tests.length,
		filePattern: testPattern.source,
		projects: [
			{
				runner: "bun",
				project: "backend-and-scripts",
				config: "scripts/verify.ts",
				files: tests.filter((p) => runnerFor(p) === "bun"),
				route: "verify:all",
			},
			{
				runner: "vitest",
				project: "web-and-client",
				config: "vitest.config.ts",
				files: tests.filter((p) =>
					["web", "client"].includes(runnerFor(p) ?? ""),
				),
				route: "verify:all",
			},
			{
				runner: "vitest",
				project: "unit",
				config: "packages/design-system/vite.config.ts",
				files: tests.filter((p) => runnerFor(p) === "design-system"),
				route: "verify:all; test:domain for owned components",
			},
			{
				runner: "vitest",
				project: "storybook",
				config: "packages/design-system/vite.config.ts",
				sources: files.filter((p) =>
					/^packages\/design-system\/src\/.*\.stories\.(js|jsx|mjs|ts|tsx)$/.test(
						p,
					),
				),
				sourceConfig: "packages/design-system/.storybook/main.ts",
				route: null,
				reason:
					"Browser project: excluded from initial CI under AGENTS.md; explicit story-file execution with --project storybook requires browser preparation",
			},
			{
				runner: "playwright",
				project: "browser",
				config: "playwright.config.ts",
				files: tests.filter((p) => p.startsWith("tests/browser/")),
				route: "bun x playwright test <explicit-file>",
			},
			{
				runner: "bun",
				project: "acceptance-driver",
				files: ["tests/acceptance/nl/driver.test.ts"],
				route:
					"bun test tests/acceptance/nl/driver.test.ts (requires Chromium)",
			},
			{
				runner: "node",
				project: "oauth-trial",
				config: "scripts/dots-oauth/package.json",
				files: ["scripts/dots-oauth/provider.test.mjs"],
				route:
					"Also covered by Bun in verify:all; standalone package command: node --test scripts/dots-oauth/provider.test.mjs",
			},
		],
		excludedFromVerifyAll: excluded,
	};
}
if (import.meta.main)
	console.log(
		JSON.stringify(testInventory(resolve(import.meta.dir, "..")), null, 2),
	);
