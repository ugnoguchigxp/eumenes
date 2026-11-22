import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CODE_GLOBS,
	DATED_LINE,
	DATED_RECORD_FILES,
	DECIDED_MODEL_FILES,
	DOC_GLOBS,
	FIXED_NAME_PATTERNS,
	scanFiles,
	scanHits,
} from "../../scripts/fixed-names";

const root = join(import.meta.dir, "../..");

test("product code has no profile or model name literal", () => {
	const paths = scanFiles(root, CODE_GLOBS);
	expect(paths.length).toBeGreaterThan(100);
	expect(scanHits(root, paths, () => false)).toEqual([]);
	for (const path of DECIDED_MODEL_FILES) {
		const decided = readFileSync(join(root, path), "utf8")
			.split("\n")
			.filter((line) =>
				FIXED_NAME_PATTERNS.some((pattern) => pattern.test(line)),
			);
		expect(decided).toHaveLength(1);
	}
});

test("product code file names carry no profile or model name", () => {
	const named = [
		...scanFiles(root, CODE_GLOBS),
		...scanFiles(root, DOC_GLOBS),
	].filter((path) => FIXED_NAME_PATTERNS.some((pattern) => pattern.test(path)));
	expect(named).toEqual([]);
});

test("procedure documents have no profile or model name outside dated records", () => {
	const paths = scanFiles(root, DOC_GLOBS).filter(
		(path) => !DATED_RECORD_FILES.has(path),
	);
	expect(paths).toContain("AGENTS.md");
	expect(paths).toContain("docs/larm.md");
	expect(scanHits(root, paths, (line) => DATED_LINE.test(line))).toEqual([]);
});

test("the name patterns match profile and model names and not the audience value", () => {
	const matches = (text: string) =>
		FIXED_NAME_PATTERNS.some((pattern) => pattern.test(text));
	expect(matches('profile: "ornith1.5Strix"')).toBe(true);
	expect(matches("SAAA-w-Image")).toBe(true);
	expect(matches("qwen-image-2.1-turbo")).toBe(true);
	expect(matches("flux-3-image-klein")).toBe(true);
	expect(matches("FLUX 3 Image Klein")).toBe(true);
	expect(matches('model: "ruri-v3-30m-speaking-attitude"')).toBe(true);
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
		"magnetic flux density",
		"influx of requests",
	])
		expect(matches(text)).toBe(false);
	expect(DATED_LINE.test("2026-10-12の実接続で確認しました")).toBe(true);
	expect(DATED_LINE.test("基本のProfileを使います")).toBe(false);
});
