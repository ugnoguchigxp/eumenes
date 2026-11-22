import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Finding } from "./verification-static";

/**
 * LLM, voice, image and music profile / model names come from saved settings and the LARM
 * catalog at run time. They are never written in product code or in procedure documents.
 */
export const FIXED_NAME_PATTERNS: readonly RegExp[] = [
	/ornith/i,
	/gemma/i,
	/qwen/i,
	/\bflux[-_.\s]?\d/i,
	/ace-?step/i,
	/SAAA-[A-Za-z]/,
	// Vendor model ids; `claude-agent-sdk` (a connection kind) and similar product names stay legal.
	/\bgpt-\d/i,
	/\bgemini-\d/i,
	/\bclaude-(?:opus|sonnet|haiku|fable|\d)/i,
	/\bvoicevox-core\b/i,
	// Classifier model ids; the attitude classifier is the catalog's system-one provider.
	/\bruri-v\d/i,
	// A name derived from a model (an engine, toolchain or label named after it).
	/(?<![a-z])luna(?![a-z])/i,
];

// `.env.example` is excluded on purpose: the file is being considered for removal.
export const CODE_GLOBS = ["api", "web/src", "client", "cli", "scripts"].map(
	(dir) => `${dir}/**/*.{ts,tsx,js,json,css}`,
);
export const DOC_GLOBS = ["AGENTS.md", "README.md", "docs/**/*.md"];

export const isTestData = (path: string) =>
	/(^|\/)(test|tests|fixtures?|node_modules)\//.test(path) ||
	/\.(test|spec|fixture)\.[a-z]+$/.test(path) ||
	/\.fixture\./.test(path);

/**
 * Frozen migration SQL that names a value persisted by an earlier release. A migration may
 * not be edited once deployed, so it keeps the old spelling; later migrations rewrite it.
 */
export const PERSISTED_VALUE_FILES = new Set([
	"api/domains/inference/repository/index.ts",
]);

/** User-pinned model contracts. Each decision is represented in one policy file. */
export const DECIDED_MODEL_FILES = new Set([
	"api/domains/web-note/service/policy.json",
	"api/domains/larm/service/embedding-policy.json",
]);

/** Files that are records of a dated verification, not procedure. */
export const DATED_RECORD_FILES = new Set(["docs/ruri-verification.md"]);

/** A line starting with a date is a dated record inside a procedure document. */
export const DATED_LINE = /^\s*(?:[-*]\s+)?\d{4}-\d{2}-\d{2}/;

export function scanFiles(root: string, patterns: readonly string[]): string[] {
	return patterns
		.flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: root })])
		.filter((path) => !isTestData(path))
		.sort();
}

/** The scanner module itself defines the regex patterns and is excluded from content scanning. */
const SCANNER_SELF_FILES = new Set(["scripts/fixed-names.ts"]);

export function scanHits(
	root: string,
	paths: readonly string[],
	skip: (line: string) => boolean,
): Finding[] {
	const found: Finding[] = [];
	for (const path of paths.filter(
		(p) =>
			!SCANNER_SELF_FILES.has(p) &&
			!PERSISTED_VALUE_FILES.has(p) &&
			!DECIDED_MODEL_FILES.has(p),
	)) {
		readFileSync(join(root, path), "utf8")
			.split("\n")
			.forEach((line, index) => {
				if (skip(line)) return;
				const name = FIXED_NAME_PATTERNS.find((pattern) => pattern.test(line));
				if (name)
					found.push({
						text: `fixed-names: ${path}:${index + 1} ${name}`,
						path,
					});
			});
	}
	return found;
}

/** Runs all fixed-name rules and returns path-attributed findings compatible with partition(). */
export function checkFixedNames(
	root = resolve(import.meta.dir, ".."),
): Finding[] {
	const findings: Finding[] = [];
	const codePaths = scanFiles(root, CODE_GLOBS);
	const docPaths = scanFiles(root, DOC_GLOBS);

	findings.push(...scanHits(root, codePaths, () => false));
	for (const path of DECIDED_MODEL_FILES) {
		const decided = readFileSync(join(root, path), "utf8")
			.split("\n")
			.filter((line) =>
				FIXED_NAME_PATTERNS.some((pattern) => pattern.test(line)),
			);
		if (decided.length !== 1) {
			findings.push({
				text: `fixed-names: ${path} must contain exactly 1 decided model line (found ${decided.length})`,
				path,
			});
		}
	}

	for (const path of [...codePaths, ...docPaths]) {
		const hit = FIXED_NAME_PATTERNS.find((pattern) => pattern.test(path));
		if (hit)
			findings.push({
				text: `fixed-names: file name carries model/profile name: ${path} (${hit})`,
				path,
			});
	}

	findings.push(
		...scanHits(
			root,
			docPaths.filter((path) => !DATED_RECORD_FILES.has(path)),
			(line) => DATED_LINE.test(line),
		),
	);
	return findings;
}

if (import.meta.main) {
	const findings = checkFixedNames();
	if (findings.length) {
		console.error(findings.map((f) => f.text).join("\n"));
		process.exit(1);
	}
	console.log("fixed-names ok");
}
