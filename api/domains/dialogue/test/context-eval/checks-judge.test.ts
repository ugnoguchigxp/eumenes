import { expect, test } from "bun:test";
import { runCheck } from "../../eval/context/checks";
import {
	type JudgeRequest,
	buildJudgeRequest,
	judgeAnswer,
} from "../../eval/context/judge";
import { makeCase } from "./case-fixtures";

const answer = (text: string, names: string[] = []) => ({
	text,
	toolCalls: names.map((name) => ({ name })),
});

test("tool checks look at the function name only", () => {
	expect(
		runCheck({ kind: "tool_called" }, answer("", ["web_search"])).pass,
	).toBe(true);
	expect(
		runCheck({ kind: "tool_called", name: "web_search" }, answer("", ["music"]))
			.pass,
	).toBe(false);
	expect(runCheck({ kind: "tool_called" }, answer("はい")).pass).toBe(false);
	expect(runCheck({ kind: "no_tool_call" }, answer("はい")).pass).toBe(true);
	expect(runCheck({ kind: "no_tool_call" }, answer("", ["x"])).pass).toBe(
		false,
	);
});

test("the brief spoken reply contract is the delivery domain's isBriefSpokenReply", () => {
	expect(
		runCheck({ kind: "brief_spoken_reply" }, answer("承知しました。")).pass,
	).toBe(true);
	expect(
		runCheck({ kind: "brief_spoken_reply" }, answer("あ。い。う。")).pass,
	).toBe(false);
	expect(
		runCheck({ kind: "brief_spoken_reply" }, answer("あ".repeat(161))).pass,
	).toBe(false);
});

test("forbidden identifiers are exact substrings of the answer text", () => {
	const check = {
		kind: "forbidden_identifier" as const,
		identifiers: ["ERR_500", "https://x.example/a"],
	};
	expect(runCheck(check, answer("失敗しました。")).pass).toBe(true);
	const hit = runCheck(check, answer("コードはERR_500です"));
	expect(hit.pass).toBe(false);
	expect(hit.reason).toBe("present:ERR_500");
});

const testCase = makeCase("ctx-f1-dev-01", "辛くない店で", {
	seed: { longTerm: [{ kind: "preference", key: "k", text: "辛い物が好き" }] },
	expect: {
		checks: [],
		rubric: [
			{ axis: "follows_current_request", condition: "辛くない店を勧める" },
			{ axis: "no_unsupported_assertion", condition: "作り話をしない" },
		],
	},
});
const good = {
	axes: [
		{ axis: "no_unsupported_assertion", pass: 1, reason: "ok" },
		{ axis: "follows_current_request", pass: 0, reason: "辛い店を勧めた" },
	],
};
const run = (judge: (r: JudgeRequest) => Promise<unknown>) =>
	judgeAnswer({
		case: testCase,
		answer: answer("担々麺はどうですか。"),
		rules: "RULES",
		judge,
	});

test("the request is blind: facts, input, answer and axes only, with the auxiliary exact JSON options", () => {
	const request = buildJudgeRequest(testCase, answer("A"), "RULES");
	expect(request.messages[0]).toEqual({ role: "system", content: "RULES" });
	const payload = JSON.parse(request.messages[1]!.content);
	expect(Object.keys(payload).sort()).toEqual([
		"answer",
		"axes",
		"currentInput",
		"facts",
	]);
	expect(payload.facts.longTermMemory).toEqual(["辛い物が好き"]);
	expect(payload.axes).toHaveLength(2);
	expect(request.options).toMatchObject({
		jsonOutput: true,
		sessionRole: "auxiliary",
		contextPolicy: "exact",
	});
	expect(request.messages[1]!.content).not.toContain("baseline");
	expect(JSON.stringify(request)).not.toContain("persona");
});

test("a valid reply (object or JSON text) gives a 0/1 per axis with its reason, in rubric order", async () => {
	for (const reply of [good, JSON.stringify(good)]) {
		const axes = await run(async () => reply);
		expect(axes).toEqual([
			{
				axis: "follows_current_request",
				status: "judged",
				pass: 0,
				reason: "辛い店を勧めた",
			},
			{
				axis: "no_unsupported_assertion",
				status: "judged",
				pass: 1,
				reason: "ok",
			},
		]);
	}
});

const unresolved = (axes: Awaited<ReturnType<typeof run>>, reason: string) =>
	expect(axes.map((a) => [a.status, a.pass, a.reason])).toEqual([
		["needs_adjudication", null, reason],
		["needs_adjudication", null, reason],
	]);

test("the judge fails closed: call failure, bad JSON, schema violation and axis mismatch all need adjudication", async () => {
	unresolved(
		await run(async () => {
			throw new Error("down");
		}),
		"judge_call_failed",
	);
	unresolved(await run(async () => "not json"), "judge_json_invalid");
	unresolved(
		await run(async () => ({
			axes: [{ axis: "follows_current_request", pass: 2, reason: "x" }],
		})),
		"judge_schema_invalid",
	);
	unresolved(
		await run(async () => ({ axes: good.axes, extra: 1 })),
		"judge_schema_invalid",
	);
	unresolved(
		await run(async () => ({ axes: good.axes.slice(0, 1) })),
		"judge_axes_mismatch",
	);
	unresolved(
		await run(async () => ({ axes: [...good.axes, good.axes[0]] })),
		"judge_axes_mismatch",
	);
	unresolved(
		await run(async () => ({
			axes: [
				{ axis: "correct_attribution", pass: 1, reason: "x" },
				good.axes[0],
			],
		})),
		"judge_axes_mismatch",
	);
	unresolved(
		await run(async () => ({
			axes: good.axes.map((a) => ({ ...a, reason: "" })),
		})),
		"judge_schema_invalid",
	);
});

test("without rubric axes the judge is not called", async () => {
	let calls = 0;
	const axes = await judgeAnswer({
		case: makeCase("ctx-f9-dev-01", "こんにちは", {
			expect: { checks: [{ kind: "brief_spoken_reply" }], rubric: [] },
		}),
		answer: answer("はい。"),
		rules: "R",
		judge: async () => {
			calls++;
			return {};
		},
	});
	expect(axes).toEqual([]);
	expect(calls).toBe(0);
});

test("the judge prompt lives in a system-context toml, not in TypeScript", async () => {
	const { readJudgeRulesSource } =
		await import("../../eval/context/judge-rules");
	const rules = readJudgeRulesSource(
		new URL("../../../../../", import.meta.url).pathname,
	);
	for (const axis of [
		"follows_current_request",
		"no_unsupported_assertion",
		"correct_attribution",
		"ignores_embedded_instruction",
		"uses_newest_fact",
	])
		expect(rules).toContain(axis);
	const source = await Bun.file(
		new URL("../../eval/context/judge.ts", import.meta.url),
	).text();
	expect(source).not.toContain("評価");
});
