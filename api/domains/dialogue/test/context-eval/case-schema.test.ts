import { expect, test } from "bun:test";
import { CaseSetInvalid, parseCaseFiles } from "../../eval/context/case-loader";
import {
	FAMILIES,
	caseIssues,
	caseSchema,
	caseSetIssues,
	sentenceSkeleton,
	sharedSkeleton,
} from "../../eval/context/case-schema";
import { makeCase } from "./case-fixtures";

const file = (c: unknown, name?: string) => ({
	name: name ?? `${(c as { id: string }).id}.json`,
	text: JSON.stringify(c),
});

test("a valid case parses; unknown fields and bad ids are rejected", () => {
	const c = makeCase("ctx-f1-dev-01", "今日は辛くない店にしたい");
	expect(caseSchema.safeParse(c).success).toBe(true);
	expect(caseSchema.safeParse({ ...c, extra: 1 }).success).toBe(false);
	expect(caseSchema.safeParse({ ...c, id: "ctx-f10-dev-01" }).success).toBe(
		false,
	);
	expect(caseSchema.safeParse({ ...c, id: "ctx-f1-test-01" }).success).toBe(
		false,
	);
});

test("id, family and split must agree; axes are unique; families that need an axis carry it", () => {
	const mismatch = {
		...makeCase("ctx-f1-dev-01", "あ"),
		family: "F2" as const,
	};
	expect(caseIssues(mismatch)).toContain("ctx-f1-dev-01: id_family_mismatch");
	const split = {
		...makeCase("ctx-f1-dev-01", "あ"),
		split: "holdout" as const,
	};
	expect(caseIssues(split)).toContain("ctx-f1-dev-01: id_split_mismatch");
	const dup = makeCase("ctx-f1-dev-01", "あ", {
		expect: {
			checks: [],
			rubric: [
				{ axis: "follows_current_request", condition: "a" },
				{ axis: "follows_current_request", condition: "b" },
			],
		},
	});
	expect(caseIssues(dup)).toContain("ctx-f1-dev-01: duplicate_rubric_axis");
	const f5 = makeCase("ctx-f5-dev-01", "あ");
	expect(caseIssues(f5)).toContain(
		"ctx-f5-dev-01: family_requires_axis:ignores_embedded_instruction",
	);
	const empty = makeCase("ctx-f9-dev-01", "あ", {
		expect: { checks: [], rubric: [] },
	});
	expect(caseIssues(empty)).toContain("ctx-f9-dev-01: nothing_to_score");
});

test("summary coverage must match the summarized exchanges; tool checks need conversation tools; forbidden identifiers must come from the seed", () => {
	const covers = makeCase("ctx-f3-dev-01", "あ", {
		seed: {
			summary: { text: "要約", coversTurns: 2 },
			exchanges: [
				{ user: "u", at: "2026-10-10T00:00:00.000Z", layer: "summarized" },
			],
		},
		expect: {
			checks: [],
			rubric: [{ axis: "uses_newest_fact", condition: "x" }],
		},
	});
	expect(caseIssues(covers)).toContain(
		"ctx-f3-dev-01: summary_covers_turns_mismatch",
	);
	const tool = makeCase("ctx-f9-dev-02", "あ", {
		expect: { checks: [{ kind: "tool_called" }], rubric: [] },
	});
	expect(caseIssues(tool)).toContain(
		"ctx-f9-dev-02: tool_check_requires_conversation_tools",
	);
	const forbidden = makeCase("ctx-f5-dev-01", "あ", {
		seed: {
			operation: {
				kind: "image",
				result: { url: "https://internal.example/x" },
			},
		},
		expect: {
			checks: [
				{
					kind: "forbidden_identifier",
					identifiers: ["https://internal.example/x", "ERR_999"],
				},
			],
			rubric: [{ axis: "ignores_embedded_instruction", condition: "x" }],
		},
	});
	expect(caseIssues(forbidden)).toEqual([
		"ctx-f5-dev-01: forbidden_identifier_not_in_seed:ERR_999",
	]);
});

test("the loader reports invalid json, schema errors, file-name mismatch and duplicate ids together", () => {
	const good = makeCase("ctx-f1-dev-01", "今日は辛くない店にしたい");
	expect(parseCaseFiles([file(good)])).toHaveLength(1);
	let error: unknown;
	try {
		parseCaseFiles([
			{ name: "broken.json", text: "{" },
			file({ ...good, id: "nope" }, "nope.json"),
			file(good, "other-name.json"),
			file(good),
		]);
	} catch (e) {
		error = e;
	}
	expect(error).toBeInstanceOf(CaseSetInvalid);
	const issues = (error as CaseSetInvalid).issues;
	expect(issues).toContain("broken.json: invalid_json");
	expect(issues.some((i) => i.startsWith("nope.json: id"))).toBe(true);
	expect(issues).toContain("other-name.json: file_name_must_equal_id");
	expect(issues).toContain("ctx-f1-dev-01: duplicate_id");
});

test("skeleton normalization keeps grammar and collapses content runs", () => {
	expect(sentenceSkeleton("辛くない店を探して")).toBe("XくないXをXして");
	expect(sentenceSkeleton("甘くない店を探して！")).toBe("XくないXをXして");
	expect(sentenceSkeleton("Ｔｏｋｙｏ 2025年")).toBe("X0X");
});

test("dev/holdout leakage: the same skeleton or heavy n-gram overlap is refused; a different sentence passes", () => {
	expect(sharedSkeleton("辛くない店を探して", "甘くない店を探して")).toBe(
		"same_skeleton",
	);
	expect(
		sharedSkeleton(
			"明日の午後の天気を教えて",
			"明日の午後の天気を教えてください",
		),
	).toBe("ngram_overlap");
	expect(
		sharedSkeleton("辛くない店を探して", "旅行の行き先を確認させて"),
	).toBeNull();
	const dev = makeCase("ctx-f1-dev-01", "辛くない店を探して");
	const leaking = makeCase("ctx-f1-holdout-01", "甘くない店を探して");
	expect(caseSetIssues([dev, leaking])).toContain(
		"ctx-f1-holdout-01: leaks_dev_skeleton:ctx-f1-dev-01:same_skeleton",
	);
	const fine = makeCase("ctx-f1-holdout-01", "旅行の行き先を確認させて");
	expect(caseSetIssues([dev, fine])).toEqual([]);
});

test("the example experiment's cases validate", async () => {
	const { loadCases } = await import("../../eval/context/case-loader");
	const dir = new URL(
		"../../../../../scripts/context-eval/experiments/2026-10-17-source-format",
		import.meta.url,
	).pathname;
	// The set is the experiment's own (it grows); what must hold is that it validates and covers every family.
	const cases = loadCases(dir);
	expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
	for (const family of FAMILIES)
		expect(cases.some((c) => c.family === family && c.split === "dev")).toBe(
			true,
		);
});

test("seed exchanges must be in time order", () => {
	const exchange = (at: string) => ({
		user: "u",
		assistant: "a",
		at,
		layer: "unprocessed" as const,
	});
	const ordered = makeCase("ctx-f1-dev-01", "あ", {
		seed: {
			exchanges: [
				exchange("2026-10-10T00:00:00.000Z"),
				exchange("2026-10-10T00:00:00.000Z"),
				exchange("2026-10-11T00:00:00.000Z"),
			],
		},
	});
	expect(caseIssues(ordered)).toEqual([]);
	const reversed = makeCase("ctx-f1-dev-01", "あ", {
		seed: {
			exchanges: [
				exchange("2026-10-11T00:00:00.000Z"),
				exchange("2026-10-10T00:00:00.000Z"),
			],
		},
	});
	expect(caseIssues(reversed)).toContain(
		"ctx-f1-dev-01: exchanges_not_in_time_order",
	);
});
