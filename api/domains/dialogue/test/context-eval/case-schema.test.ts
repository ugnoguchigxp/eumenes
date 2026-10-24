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
const user = (at: string, text: string, key?: string) => ({
	type: "said" as const,
	by: "user" as const,
	at,
	text,
	...(key ? { key } : {}),
});

test("a valid case parses; unknown fields and bad ids are rejected", () => {
	const c = makeCase("ctx-f1-dev-01", "今日は辛くない店にしたい");
	expect(caseSchema.safeParse(c).success).toBe(true);
	expect(caseSchema.safeParse({ ...c, extra: 1 }).success).toBe(false);
	expect(caseSchema.safeParse({ ...c, tools: "none" }).success).toBe(false);
	expect(caseSchema.safeParse({ ...c, id: "ctx-f15-dev-01" }).success).toBe(
		false,
	);
	expect(caseSchema.safeParse({ ...c, id: "ctx-f1-test-01" }).success).toBe(
		false,
	);
	expect(
		caseSchema.safeParse({ ...c, id: "ctx-f14-dev-01", family: "F14" }).success,
	).toBe(true);
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
	expect(caseIssues(makeCase("ctx-f5-dev-01", "あ"))).toContain(
		"ctx-f5-dev-01: family_requires_axis:ignores_embedded_instruction",
	);
	expect(caseIssues(makeCase("ctx-f11-dev-01", "あ"))).toContain(
		"ctx-f11-dev-01: family_requires_axis:delivery_aware",
	);
	const empty = makeCase("ctx-f9-dev-01", "あ", {
		expect: { checks: [], rubric: [] },
	});
	expect(caseIssues(empty)).toContain("ctx-f9-dev-01: nothing_to_score");
});

test("a generation without an utterance needs a trigger, and an utterance has none", () => {
	const fixed = makeCase("ctx-f12-dev-01", null, {
		expect: {
			checks: [{ kind: "speaks" }],
			rubric: [{ axis: "speech_judgment", condition: "話す" }],
		},
	});
	expect(caseIssues(fixed)).toEqual([]);
	const { trigger: _trigger, ...noTrigger } = fixed;
	expect(caseIssues(noTrigger as typeof fixed)).toContain(
		"ctx-f12-dev-01: trigger_required_without_input",
	);
	const both = makeCase("ctx-f1-dev-01", "あ", { trigger: { kind: "timer" } });
	expect(caseIssues(both)).toContain("ctx-f1-dev-01: trigger_with_input");
});

test("references must name a seeded key, keys are unique, delivery fields agree with how much was heard", () => {
	const agent = (extra: Record<string, unknown>) => ({
		type: "said" as const,
		by: "agent" as const,
		at: "2026-10-10T00:00:05.000Z",
		text: "t",
		origin: "spontaneous" as const,
		...extra,
	});
	const seeded = (events: unknown[], work?: unknown[]) =>
		makeCase("ctx-f1-dev-01", "あ", {
			seed: { events, ...(work ? { work } : {}) } as never,
		});
	expect(
		caseIssues(
			seeded([
				user("2026-10-10T00:00:00.000Z", "u", "a"),
				agent({ about: ["@a"] }),
			]),
		),
	).toEqual([]);
	expect(caseIssues(seeded([agent({ about: ["@ghost"] })]))).toContain(
		"ctx-f1-dev-01: unknown_ref:@ghost",
	);
	expect(
		caseIssues(
			seeded([
				user("2026-10-10T00:00:00.000Z", "u", "a"),
				user("2026-10-10T00:00:01.000Z", "v", "a"),
			]),
		),
	).toContain("ctx-f1-dev-01: duplicate_key");
	expect(caseIssues(seeded([agent({ heard: "partial" })]))).toContain(
		"ctx-f1-dev-01: partial_without_delivered_text",
	);
	expect(caseIssues(seeded([agent({ deliveredText: "x" })]))).toContain(
		"ctx-f1-dev-01: delivered_text_without_partial",
	);
	expect(caseIssues(seeded([agent({ heard: null, speaking: true })]))).toEqual(
		[],
	);
	expect(caseIssues(seeded([agent({ speaking: true })]))).toContain(
		"ctx-f1-dev-01: speaking_with_delivery",
	);
});

test("episode parts, TODOs, tendencies and forbidden identifiers are checked against the seed", () => {
	const events = [user("2026-10-10T00:00:00.000Z", "u")];
	const summary = makeCase("ctx-f3-dev-01", "あ", {
		seed: { episode: [{ kind: "summary", events }] },
		expect: {
			checks: [],
			rubric: [{ axis: "uses_newest_fact", condition: "x" }],
		},
	});
	expect(caseIssues(summary)).toContain("ctx-f3-dev-01: summary_without_text");
	const work = makeCase("ctx-f14-dev-01", "あ", {
		seed: {
			work: [
				{
					key: "w1",
					toolchain: "t",
					request: "r",
					at: "2026-10-10T00:00:00.000Z",
					status: "done",
				},
				{
					key: "w2",
					toolchain: "t",
					request: "r",
					at: "2026-10-10T00:00:00.000Z",
					status: "waiting",
				},
				{
					key: "w3",
					toolchain: "t",
					request: "r",
					at: "2026-10-10T00:00:00.000Z",
					status: "todo",
					archived: true,
				},
			],
		},
		expect: {
			checks: [],
			rubric: [{ axis: "work_state_aware", condition: "x" }],
		},
	});
	expect(caseIssues(work)).toEqual([
		"ctx-f14-dev-01: done_work_without_outcome:w1",
		"ctx-f14-dev-01: waiting_work_without_question:w2",
		"ctx-f14-dev-01: archived_work_not_done:w3",
	]);
	const tendency = makeCase("ctx-f1-dev-01", "あ", {
		seed: { tendencies: [{ text: "t", from: ["nowhere", "nowhere2"] }] },
	});
	expect(caseIssues(tendency)).toContain(
		"ctx-f1-dev-01: tendency_from_unknown_item:nowhere",
	);
	const forbidden = makeCase("ctx-f5-dev-01", "あ", {
		seed: {
			work: [
				{
					key: "w1",
					toolchain: "t",
					request: "r",
					at: "2026-10-10T00:00:00.000Z",
					status: "done",
					outcome: "failed",
					result: { url: "https://internal.example/x" },
				},
			],
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

test("the example experiment's cases validate and cover every family in both splits", async () => {
	const { loadCases } = await import("../../eval/context/case-loader");
	const dir = new URL(
		"../../../../../scripts/context-eval/experiments/2026-10-24-context-window",
		import.meta.url,
	).pathname;
	const cases = loadCases(dir);
	expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
	for (const family of FAMILIES)
		for (const split of ["dev", "holdout"])
			expect(cases.some((c) => c.family === family && c.split === split)).toBe(
				true,
			);
});
