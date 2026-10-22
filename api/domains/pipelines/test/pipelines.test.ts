import { describe, expect, test } from "bun:test";
import type { PipelineDefinition } from "../../capabilities";
import {
	checkPipeline,
	expand,
	expandValue,
	inputParameters,
	parseInputs,
	runFixture,
	stepFault,
	stepOutline,
	type ToolchainLookup,
} from "..";
import { cookTimerMusic } from "./pipeline.fixture";

const lookup: ToolchainLookup = (id) =>
	({
		"web.search": { execution: "research" as const },
		"timers.manage": { execution: "command" as const },
		"music.create": { execution: "music-create" as const },
		"ui.compose": { execution: "session" as const },
		"weather.forecast": {
			execution: "instant" as const,
			arguments: ["place", "day"],
		},
	})[id] ?? null;

const clone = () => structuredClone(cookTimerMusic);

describe("pipeline check", () => {
	test("a sound definition passes", () => {
		expect(checkPipeline(cookTimerMusic, lookup)).toEqual({
			ok: true,
			value: cookTimerMusic,
		});
	});
	test("each rule is reported by its place, never by the value", () => {
		const d = clone() as PipelineDefinition & { steps: any[] };
		d.steps[0].request = "${steps.timer.summary}を調べる";
		d.steps[2].request = "${steps.research.value}分";
		d.steps[3].toolchain = "ui.compose";
		d.steps.push({
			id: "weather",
			kind: "toolchain",
			title: "天気",
			toolchain: "weather.forecast",
			request: "天気",
			arguments: { city: "${inputs.food}" },
		});
		d.answer = "${inputs.nothing}";
		const result = checkPipeline(d, lookup);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.issues).toEqual([
			{ pointer: "/steps/0/request", rule: "forward_reference" },
			{ pointer: "/steps/2/request", rule: "field_mismatch" },
			{ pointer: "/steps/3/toolchain", rule: "unsupported_toolchain" },
			{ pointer: "/steps/4/arguments/city", rule: "unknown_argument" },
			{ pointer: "/answer", rule: "unknown_reference" },
		]);
	});
	test("format errors come first, with their pointer", () => {
		const d = clone() as any;
		d.steps = [d.steps[0]];
		d.inputs.food_quote = d.inputs.food;
		const result = checkPipeline(d, lookup);
		expect(!result.ok && result.issues.map((i) => i.pointer)).toEqual([
			"/inputs",
			"/steps",
		]);
	});
	test("an unknown toolchain and a missing step result fail the check", () => {
		const d = clone() as any;
		d.steps[1].from = ["${steps.gone.summary}"];
		d.steps[3].toolchain = "music.gone";
		const result = checkPipeline(d, lookup);
		expect(!result.ok && result.issues).toEqual([
			{ pointer: "/steps/1/from/0", rule: "unknown_reference" },
			{ pointer: "/steps/3/toolchain", rule: "unknown_toolchain" },
		]);
	});
});

test("inputs may not take the first round's names; an optional input without a default may not be read; inherited names are unknown", () => {
	const d = clone() as any;
	d.inputs.kind = { type: "string", description: "種類", required: true };
	d.inputs.extra = { type: "string", description: "任意", required: false };
	d.steps[3].request = "${inputs.extra}の曲";
	d.answer = "${inputs.constructor}";
	const result = checkPipeline(d, lookup);
	expect(!result.ok && result.issues).toEqual([
		{ pointer: "/inputs/kind", rule: "reserved_input_name" },
		{ pointer: "/steps/3/request", rule: "optional_input_referenced" },
		{ pointer: "/answer", rule: "unknown_reference" },
	]);
});

describe("inputs", () => {
	test("the first round's parameters are flat, with a quote for each input", () => {
		const p = inputParameters(cookTimerMusic);
		expect(Object.keys(p.properties)).toEqual([
			"food",
			"food_quote",
			"mood",
			"mood_quote",
		]);
		expect(p.required).toEqual(["food", "food_quote"]);
	});
	test("a quote must be the user's words; an unmentioned input takes its default", () => {
		const request = "ペンネを 茹でる時間を調べて、タイマーと曲もお願い";
		expect(
			parseInputs(
				cookTimerMusic,
				{ food: "ペンネ", food_quote: "ペンネを茹でる" },
				request,
			),
		).toEqual({ ok: true, value: { food: "ペンネ", mood: "落ち着いた" } });
		expect(
			parseInputs(
				cookTimerMusic,
				{ food: "ペンネ", food_quote: "スパゲッティ", mood: "明るい" },
				request,
			),
		).toEqual({
			ok: false,
			issues: [
				{ path: "food_quote", code: "quote_not_in_request" },
				{ path: "mood_quote", code: "required" },
			],
		});
		// Punctuation quotes nothing of the user's words.
		expect(
			parseInputs(
				cookTimerMusic,
				{ food: "ペンネ", food_quote: "、" },
				request,
			),
		).toEqual({
			ok: false,
			issues: [{ path: "food_quote", code: "quote_not_in_request" }],
		});
		expect(parseInputs(cookTimerMusic, { extra: 1 }, request)).toEqual({
			ok: false,
			issues: [
				{ path: "extra", code: "unrecognized_key" },
				{ path: "food", code: "required" },
			],
		});
	});
});

describe("templates and steps", () => {
	const scope = {
		inputs: { food: "ペンネ" },
		steps: {
			research: { summary: "11分", output: { a: { b: 3 } } },
			minutes: { value: 11 },
		},
	};
	test("references expand; a whole reference keeps its type", () => {
		expect(expand("${inputs.food}は${steps.minutes.value}分", scope)).toBe(
			"ペンネは11分",
		);
		expect(expandValue("${steps.research.output.a.b}", scope)).toBe(3);
		expect(() => expand("${steps.timer.summary}", scope)).toThrow(
			"pipeline_reference_missing",
		);
	});
	test("a step passes only when it completed with what it requires", () => {
		const step = cookTimerMusic.steps[2] as Extract<
			PipelineDefinition["steps"][number],
			{ kind: "toolchain" }
		>;
		expect(stepFault(step, { state: "completed", output: { id: 1 } })).toBe(
			null,
		);
		expect(stepFault(step, { state: "completed" })).toBe(
			"pipeline_step_output_missing",
		);
		expect(stepFault(step, { state: "failed", output: {} })).toBe(
			"pipeline_step_failed",
		);
		expect(stepOutline(cookTimerMusic)).toBe("調べる→タイマー→曲");
	});
	test("a fixture case runs without toolchains and compares the expected values", () => {
		const out = runFixture(cookTimerMusic, 0);
		expect(out.passed).toBe(true);
		expect(out.steps.map((s) => s.request)).toEqual([
			"ペンネの標準的な茹で時間を調べてください",
			"ペンネの茹で時間は11〜12分が目安",
			"11分のタイマーを掛けてください",
			"明るいな曲を作ってください",
		]);
		expect(out.answer).toBe("ペンネは約11分です。");
		const broken = clone();
		broken.tests![0]!.stepResults.minutes = { value: 500 };
		const failed = runFixture(broken, 0);
		expect(failed.passed).toBe(false);
		expect(failed.failures[0]).toEqual({
			path: "steps.minutes.value",
			code: "too_big",
		});
	});
});
