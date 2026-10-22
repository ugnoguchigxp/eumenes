import { expect, test } from "bun:test";
import type { PipelineDefinition, PipelineMaterial } from "../../capabilities";
import {
	checkPipeline,
	flowOf,
	resolvePipelineMaterials,
	runFixture,
} from "..";
import { cookTimerMusic } from "./pipeline.fixture";

const scope = {
	inputs: { food: "ペンネ", mood: false },
	steps: {
		research: {
			summary: "結果",
			output: { nested: { n: 0, nil: null, list: [false, "", { x: 1 }] } },
		},
		minutes: { value: 11 },
	},
};
const lookup = () => ({ execution: "command" as const });

test("materials preserve body, raw prompts, typed values and owned media IDs independently", () => {
	const body = "  本文\n${steps.minutes.value}\n ";
	const values: PipelineMaterial[] = [
		{ kind: "text", text: body },
		{ kind: "value", value: { list: [0, false, null, ""] } },
		{ kind: "request" },
		{ kind: "prompt", stepId: "music" },
		{ kind: "reference", reference: "steps.research.output.nested.nil" },
		{ kind: "reference", reference: "steps.research.output.nested.n" },
		{ kind: "reference", reference: "inputs.mood" },
		{ kind: "result", stepId: "research" },
		{ kind: "image", id: "image-1", title: "選択画像" },
		{ kind: "music", id: "track-1", title: "選択曲" },
	];
	const resolved = resolvePipelineMaterials(
		cookTimerMusic,
		values,
		scope,
		"毎回の依頼",
	);
	expect(resolved.map((m) => m.value)).toEqual([
		body,
		{ list: [0, false, null, ""] },
		"毎回の依頼",
		"${inputs.mood}な曲を作ってください",
		null,
		0,
		false,
		scope.steps.research,
		{ imageRef: "image-1" },
		{ trackId: "track-1" },
	]);
	expect(
		resolvePipelineMaterials(
			cookTimerMusic,
			[{ kind: "request" }],
			scope,
			"別の依頼",
		)[0]?.value,
	).toBe("別の依頼");
});

test("missing paths fail, null is data, UTF-8 capacity fails instead of truncating", () => {
	expect(() =>
		resolvePipelineMaterials(
			cookTimerMusic,
			[{ kind: "reference", reference: "steps.research.output.absent" }],
			scope,
			"",
		),
	).toThrow("pipeline_material_missing");
	expect(() =>
		resolvePipelineMaterials(
			cookTimerMusic,
			[{ kind: "text", text: "あ".repeat(6000) }],
			scope,
			"",
		),
	).toThrow("pipeline_material_capacity");
	expect(
		resolvePipelineMaterials(cookTimerMusic, undefined, scope, ""),
	).toEqual([]);
});

test("references are contract checked, forward results rejected and raw self prompts allowed", () => {
	const d = structuredClone(cookTimerMusic);
	const first = d.steps[0] as Extract<
		PipelineDefinition["steps"][number],
		{ kind: "toolchain" }
	>;
	first.materials = [{ kind: "prompt", stepId: first.id }];
	expect(checkPipeline(d, lookup).ok).toBe(true);
	first.materials = [
		{ kind: "reference", reference: "${broken" },
		{ kind: "result", stepId: "music" },
		{ kind: "prompt", stepId: "music" },
		{ kind: "prompt", stepId: "minutes" },
	];
	const checked = checkPipeline(d, lookup);
	expect(!checked.ok && checked.issues).toEqual([
		{ pointer: "/steps/0/materials/0/reference", rule: "unknown_reference" },
		{ pointer: "/steps/0/materials/1/stepId", rule: "forward_reference" },
		{ pointer: "/steps/0/materials/2/stepId", rule: "unknown_prompt" },
		{ pointer: "/steps/0/materials/3/stepId", rule: "unknown_prompt" },
	]);
	first.materials = [{ kind: "text", text: "資料" }];
	const instant = checkPipeline(d, () => ({
		execution: "instant",
		arguments: [],
	}));
	expect(!instant.ok && instant.issues).toContainEqual({
		pointer: "/steps/0/materials",
		rule: "instant_materials_unsupported",
	});
});

test("fixture and flow report what is passed, not a fixed sample replacing the reference", () => {
	const d = structuredClone(cookTimerMusic);
	const last = d.steps[3] as Extract<
		PipelineDefinition["steps"][number],
		{ kind: "toolchain" }
	>;
	last.materials = [
		{ kind: "result", stepId: "research" },
		{ kind: "reference", reference: "inputs.food" },
		{ kind: "reference", reference: "steps.minutes.value" },
		{ kind: "prompt", stepId: "music" },
	];
	const flow = flowOf(d).steps[3]!;
	expect(flow.reads).toContain("research");
	expect(flow.reads).toContain("minutes");
	expect(flow.inputs).toContain("food");
	const out = runFixture(d, 0);
	expect(out.passed).toBe(true);
	expect(out.steps[3]?.materials?.map((m) => m.value)).toEqual([
		d.tests![0]!.stepResults.research,
		"ペンネ",
		11,
		last.request,
	]);
});
