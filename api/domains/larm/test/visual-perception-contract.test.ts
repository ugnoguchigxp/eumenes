import { expect, test } from "bun:test";
import {
	perceptionResult,
	perceptionTask,
} from "../contracts/visual-perception";
import { cpuVisualResult, visualResult } from "./visual-perception.fixture";

test("CPU description requires an absent decoder and measured image tokens below input tokens", async () => {
	const cpu = await cpuVisualResult();
	expect(perceptionResult.parse(cpu)).toEqual(cpu);
	const transformers = await visualResult("segmentation");
	expect(perceptionResult.parse(transformers)).toEqual(transformers);
});
test.each(["decoderDtype", "visualTokens", "inputTokens", "outputTokens"])(
	"CPU rejects omitted %s without filling a default",
	async (key) => {
		const cpu = await cpuVisualResult();
		const execution: Record<string, unknown> = { ...cpu.execution };
		delete execution[key];
		expect(perceptionResult.safeParse({ ...cpu, execution }).success).toBe(
			false,
		);
	},
);
test.each([
	["decoderDtype", "float32"],
	["decoderDtype", ""],
	["visualTokens", null],
	["visualTokens", 0],
	["visualTokens", -1],
	["visualTokens", 1.5],
	["visualTokens", 20],
	["visualTokens", 21],
	["visualTokens", Number.MAX_SAFE_INTEGER + 1],
	["inputTokens", null],
	["inputTokens", 0],
	["inputTokens", -1],
	["inputTokens", 1.5],
	["outputTokens", null],
	["outputTokens", -1],
	["outputTokens", 1.5],
	["device", "cuda:0"],
	["backend", "transformers"],
	["dtype", "bfloat16"],
])("CPU rejects invalid execution.%s=%j", async (key, value) => {
	const cpu = await cpuVisualResult();
	expect(
		perceptionResult.safeParse({
			...cpu,
			execution: { ...cpu.execution, [String(key)]: value },
		}).success,
	).toBe(false);
});
test.each(perceptionTask.options.filter((task) => task !== "describe"))(
	"CPU rejects task %s",
	async (task) => {
		expect(
			perceptionResult.safeParse({ ...(await cpuVisualResult()), task })
				.success,
		).toBe(false);
	},
);
test("CPU rejects objects, masks, count and undeclared execution fields", async () => {
	const cpu = await cpuVisualResult();
	const maskResult = await visualResult("segmentation");
	for (const input of [
		{ ...cpu, detections: maskResult.detections },
		{ ...cpu, masks: maskResult.masks },
		{ ...cpu, count: 0 },
		{ ...cpu, execution: { ...cpu.execution, estimate: true } },
	])
		expect(perceptionResult.safeParse(input).success).toBe(false);
});
test.each([null, "bfloat16", "", undefined])(
	"Transformers rejects decoder dtype %j",
	async (decoderDtype) => {
		const result = await visualResult("segmentation");
		expect(
			perceptionResult.safeParse({
				...result,
				execution: { ...result.execution, decoderDtype },
			}).success,
		).toBe(false);
	},
);
test("Transformers preserves mandatory positive tokens and its published execution binding", async () => {
	const result = await visualResult("segmentation");
	for (const patch of [
		{ visualTokens: 0 },
		{ visualTokens: null },
		{ visualTokens: undefined },
		{ outputTokens: 0 },
		{ device: "cpu" },
		{ dtype: "float32" },
		{ backend: "other" },
	])
		expect(
			perceptionResult.safeParse({
				...result,
				execution: { ...result.execution, ...patch },
			}).success,
		).toBe(false);
});
