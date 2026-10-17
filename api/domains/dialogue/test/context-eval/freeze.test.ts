import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FreezeConflict,
	appendReportLine,
	buildManifest,
	createReportDir,
	freeze,
	manifestChanges,
	sha256Hex,
	verifyFrozen,
	writeReportFile,
} from "../../eval/context/freeze";

const dirs: string[] = [];
const tmp = () => {
	const dir = mkdtempSync(join(tmpdir(), "context-eval-freeze-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const enc = (s: string) => new TextEncoder().encode(s);
const files = (holdout = "H1") => [
	{ path: "cases/ctx-f1-dev-01.json", bytes: enc("dev") },
	{ path: "cases/ctx-f1-holdout-01.json", bytes: enc(holdout), holdout: true },
	{ path: "judge.toml", bytes: enc("rules") },
];
const manifest = (holdout?: string, frozenAt = "t") =>
	buildManifest({ experiment: "e", frozenAt, files: files(holdout) });

test("the manifest holds a sha256 per file and a holdout digest", () => {
	const m = manifest();
	expect(m.files["judge.toml"]).toBe(sha256Hex("rules"));
	expect(Object.keys(m.files)).toEqual([
		"cases/ctx-f1-dev-01.json",
		"cases/ctx-f1-holdout-01.json",
		"judge.toml",
	]);
	expect(manifest("H2").holdoutDigest).not.toBe(m.holdoutDigest);
	expect(manifest("H1", "later").holdoutDigest).toBe(m.holdoutDigest);
});

test("freezing twice with the same content is a no-op; changed holdout content is refused", () => {
	const dir = tmp();
	expect(freeze(dir, manifest()).created).toBe(true);
	expect(freeze(dir, manifest("H1", "later")).created).toBe(false);
	let error: unknown;
	try {
		freeze(dir, manifest("H2"));
	} catch (e) {
		error = e;
	}
	expect(error).toBeInstanceOf(FreezeConflict);
	expect((error as FreezeConflict).holdoutChanged).toBe(true);
	expect((error as FreezeConflict).changes).toEqual([
		{ path: "cases/ctx-f1-holdout-01.json", kind: "changed" },
	]);
});

test("any frozen file (judge prompt, arm source) changing is refused, as are added and removed files", () => {
	const dir = tmp();
	freeze(dir, manifest());
	const changed = buildManifest({
		experiment: "e",
		frozenAt: "t",
		files: [
			...files().slice(0, 2),
			{ path: "judge.toml", bytes: enc("other rules") },
		],
	});
	expect(() => freeze(dir, changed)).toThrow(FreezeConflict);
	const added = buildManifest({
		experiment: "e",
		frozenAt: "t",
		files: [...files(), { path: "arms.ts", bytes: enc("x") }],
	});
	expect(manifestChanges(manifest(), added)).toEqual([
		{ path: "arms.ts", kind: "added" },
	]);
	const removed = buildManifest({
		experiment: "e",
		frozenAt: "t",
		files: files().slice(0, 2),
	});
	expect(manifestChanges(manifest(), removed)).toEqual([
		{ path: "judge.toml", kind: "removed" },
	]);
	expect(verifyFrozen(dir, manifest())).toEqual([]);
	expect(verifyFrozen(dir, manifest("H2"))).toHaveLength(1);
});

test("verifyFrozen fails closed when nothing was frozen", () => {
	expect(() => verifyFrozen(tmp(), manifest())).toThrow(
		"context_eval_not_frozen",
	);
});

test("a report directory is new every time and a report file is never overwritten", () => {
	const root = tmp();
	const at = new Date("2026-10-17T09:30:15.123Z");
	const dir = createReportDir(root, "exp-1", at);
	expect(dir.endsWith("exp-1/20261017T093015123Z")).toBe(true);
	expect(statSync(dir).mode & 0o777).toBe(0o700);
	expect(() => createReportDir(root, "exp-1", at)).toThrow();
	expect(createReportDir(root, "exp-1", new Date(at.getTime() + 1))).not.toBe(
		dir,
	);
	const file = writeReportFile(dir, "RESULTS.json", "{}");
	expect(statSync(file).mode & 0o777).toBe(0o600);
	expect(() => writeReportFile(dir, "RESULTS.json", '{"x":1}')).toThrow();
	appendReportLine(dir, "raw.jsonl", { a: 1 });
	appendReportLine(dir, "raw.jsonl", { a: 2 });
	expect(existsSync(join(dir, "raw.jsonl"))).toBe(true);
	expect(() => createReportDir(root, "../escape", at)).toThrow(
		"context_eval_experiment_name_invalid",
	);
});

test("baseline prompt digests are part of the freeze: a changed product prompt is refused", () => {
	const dir = tmp();
	const withPrompts = (hash: string) =>
		buildManifest({
			experiment: "e",
			frozenAt: "t",
			files: files(),
			baselinePrompts: { "ctx-f1-dev-01": hash },
		});
	freeze(dir, withPrompts("aaa"));
	expect(freeze(dir, withPrompts("aaa")).created).toBe(false);
	let error: unknown;
	try {
		freeze(dir, withPrompts("bbb"));
	} catch (e) {
		error = e;
	}
	expect(error).toBeInstanceOf(FreezeConflict);
	expect((error as FreezeConflict).changes).toEqual([
		{ path: "baseline-prompt:ctx-f1-dev-01", kind: "changed" },
	]);
	// The file check before a run leaves the prompt digests to the run itself.
	expect(verifyFrozen(dir, manifest())).toEqual([]);
});
