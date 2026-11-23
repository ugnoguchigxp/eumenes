import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReadme } from "./check-readme";

let workspace: string;
let readme: string;
let original: string;
beforeEach(() => {
	workspace = mkdtempSync(join(tmpdir(), "eumenes-goal-example-"));
	cpSync(join(import.meta.dir, "workspace"), workspace, { recursive: true });
	readme = join(workspace, "README.md");
	original = readFileSync(readme, "utf8");
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

test("the initial instructions fail in the real CLI", () => {
	expect(checkReadme(workspace)).toMatchObject({
		passed: false,
		reason: "command_failed",
		exitCode: 2,
	});
});

test("exit zero with the wrong output leaves the goal unmet", () => {
	writeFileSync(readme, original.replace("--style json", "--format text"));
	expect(checkReadme(workspace)).toMatchObject({
		passed: false,
		reason: "unexpected_output",
		exitCode: 0,
	});
});

test("a corrected README reproduces the fixed expected values", () => {
	writeFileSync(readme, original.replace("--style json", "--format json"));
	expect(checkReadme(workspace)).toMatchObject({
		passed: true,
		reason: "verified",
		exitCode: 0,
		stdout: '{"count":3,"total":12}',
	});
});

test("a completion claim without a runnable example is insufficient", () => {
	writeFileSync(readme, "サンプルの期待出力を確認済みです。");
	expect(checkReadme(workspace)).toMatchObject({
		passed: false,
		reason: "example_missing_or_ambiguous",
	});
});

test("a missing README leaves the goal unmet", () => {
	rmSync(readme);
	expect(checkReadme(workspace)).toMatchObject({
		passed: false,
		reason: "example_missing_or_ambiguous",
	});
});

test("replacing the sample cannot satisfy the goal", () => {
	writeFileSync(readme, original.replace("--style json", "--format json"));
	writeFileSync(
		join(workspace, "sample.mjs"),
		`console.log('{"count":3,"total":12}');`,
	);
	expect(checkReadme(workspace)).toMatchObject({
		passed: false,
		reason: "sample_changed",
	});
});
