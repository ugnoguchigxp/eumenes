import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// LLM, voice, image and music profile / model names come from saved settings and the LARM
// catalog at run time. They are never written in product code or in procedure documents.
const root = join(import.meta.dir, "../..");
const names = [
	/ornith/i,
	/gemma/i,
	/qwen/i,
	/ace-?step/i,
	/SAAA-[A-Za-z]/,
	// Vendor model ids; `claude-agent-sdk` (a connection kind) and similar product names stay legal.
	/\bgpt-\d/i,
	/\bgemini-\d/i,
	/\bclaude-(?:opus|sonnet|haiku|fable|\d)/i,
	/\bvoicevox-core\b/i,
	// A name derived from a model (an engine, toolchain or label named after it).
	/(?<![a-z])luna(?![a-z])/i,
];

// `.env.example` is excluded on purpose: the file is being considered for removal (the user's
// decision is pending), so it is not scanned until that is settled.
const codeGlobs = ["api", "web/src", "client", "cli", "scripts"].map(
	(dir) => `${dir}/**/*.{ts,tsx,js,json,css}`,
);
const docGlobs = ["AGENTS.md", "README.md", "docs/**/*.md"];
const isTestData = (path: string) =>
	/(^|\/)(test|tests|fixtures?|node_modules)\//.test(path) ||
	/\.(test|spec|fixture)\.[a-z]+$/.test(path) ||
	/\.fixture\./.test(path);
/**
 * Frozen migration SQL that names a value persisted by an earlier release. A migration may
 * not be edited once deployed, so it keeps the old spelling; later migrations rewrite it.
 */
const persistedValueFiles = new Set([
	"api/domains/inference/repository/index.ts",
]);
/** Files that are records of a dated verification, not procedure. */
const datedRecordFiles = new Set(["docs/ruri-verification.md"]);
/** A line starting with a date is a dated record inside a procedure document. */
const datedLine = /^\s*(?:[-*]\s+)?\d{4}-\d{2}-\d{2}/;

function files(patterns: string[]) {
	return patterns
		.flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: root })])
		.filter((path) => !isTestData(path));
}
function hits(paths: string[], skip: (line: string) => boolean) {
	const found: string[] = [];
	for (const path of paths.filter((p) => !persistedValueFiles.has(p)))
		readFileSync(join(root, path), "utf8")
			.split("\n")
			.forEach((line, index) => {
				if (skip(line)) return;
				const name = names.find((pattern) => pattern.test(line));
				if (name) found.push(`${path}:${index + 1} ${name}`);
			});
	return found;
}

test("product code has no profile or model name literal", () => {
	const paths = files(codeGlobs);
	expect(paths.length).toBeGreaterThan(100);
	expect(hits(paths, () => false)).toEqual([]);
});

test("product code file names carry no profile or model name", () => {
	const named = [...files(codeGlobs), ...files(docGlobs)].filter((path) =>
		names.some((pattern) => pattern.test(path)),
	);
	expect(named).toEqual([]);
});

test("procedure documents have no profile or model name outside dated records", () => {
	const paths = files(docGlobs).filter((path) => !datedRecordFiles.has(path));
	expect(paths).toContain("AGENTS.md");
	expect(paths).toContain("docs/larm.md");
	expect(hits(paths, (line) => datedLine.test(line))).toEqual([]);
});

test("the name patterns match profile and model names and not the audience value", () => {
	const matches = (text: string) => names.some((pattern) => pattern.test(text));
	expect(matches('profile: "ornith1.5Strix"')).toBe(true);
	expect(matches("SAAA-w-Image")).toBe(true);
	expect(matches("qwen-image-2.1-turbo")).toBe(true);
	for (const name of [
		"gpt-6-luna",
		"voicevox-core",
		"codex_luna",
		"web.research.luna",
		"claude-sonnet-4",
		"gemini-2.5-pro",
	])
		expect(matches(`model: "${name}"`)).toBe(true);
	expect(matches('audience: "saaa-desktop"')).toBe(false);
	// Product and protocol names that look similar are not model names.
	for (const text of [
		'kind: "claude-agent-sdk"',
		"chatgpt.com/space",
		"Lunar calendar",
		"X-VOICEVOX-Credit",
		'engine: "codex"',
	])
		expect(matches(text)).toBe(false);
	expect(datedLine.test("2026-10-12の実接続で確認しました")).toBe(true);
	expect(datedLine.test("基本のProfileを使います")).toBe(false);
});
