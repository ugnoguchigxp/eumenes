import { expect, test } from "bun:test";
import {
	analysisTools,
	validateAnalysis,
	type TaskOffer,
} from "../service/initial-decision";
import { fitTaskOffer, taskOfferProjection } from "../service/task-offer";
import { estimateJsonTokens } from "../../inference";
import { analysisArgs, analysisReceipt } from "./analysis.fixture";
import type { ToolchainCard } from "../../capabilities";

const offer = (): TaskOffer => ({
	card: {
		id: "task.execute",
		revisionId: "toolchain:task.execute@1",
		functionName: "execute_task",
		title: "日常の複数操作",
		summary: "結果を使って次の能力を選ぶ",
		useWhen: [],
		avoidWhen: [],
		examples: [],
		redirects: [],
	} as unknown as ToolchainCard,
	references: [
		{
			ref: "memory:1",
			owner: "memory",
			id: "1",
			revision: "1",
			digest: "digest",
			kind: "memory",
			label: "好み",
			preview: "短い動画が好み",
		},
	],
	works: [],
});
test("R1 exposes one small delegation entry without discovery; the request and chosen source refs are the same native decision", () => {
	const tasks = offer();
	const tools = analysisTools([], new Set(), true, tasks);
	expect(tools.filter((t) => t.function.name === "execute_task")).toHaveLength(
		1,
	);
	const receipt = analysisReceipt("r1", {
		name: "execute_task",
		args: {
			...analysisArgs({ kind: "action", impact: "create" }),
			request: "条件に合うものを探して開く",
			contextRefs: ["memory:1"],
		},
	});
	const result = validateAnalysis(receipt.toolCalls!, [], true, tasks);
	expect(result).toMatchObject({
		next: "execute_task",
		request: "条件に合うものを探して開く",
		contextRefs: ["memory:1"],
	});
	const forged = analysisReceipt("r1", {
		name: "execute_task",
		args: { request: "do it", contextRefs: ["not-offered"] },
	});
	expect(() => validateAnalysis(forged.toolCalls!, [], true, tasks)).toThrow();
});

test("without a prior assistant exchange every native function exposes only approved=false; with an exchange meaning stays with the model", () => {
	const tasks = offer();
	const schema = (tool: ReturnType<typeof analysisTools>[number]) =>
		(tool.function.parameters.properties as Record<string, unknown>).approved;
	for (const tool of analysisTools([], new Set(), true, tasks, false))
		expect(schema(tool)).toEqual({ type: "boolean", const: false });
	for (const tool of analysisTools([], new Set(), true, tasks, true))
		expect(schema(tool)).not.toHaveProperty("const");
});
test("work controls and their question schema stay inside the 1024 estimated-token allowance and never offer another conversation's work", () => {
	const tasks = offer(),
		id = crypto.randomUUID(),
		questionId = crypto.randomUUID();
	tasks.works = [
		{
			id,
			conversationId: "main",
			request: "短い目的",
			revision: 2,
			status: "waiting_user",
			deadline: Date.now() + 1000,
			question: {
				id: questionId,
				prompt: "操作を続けてよいですか",
				expiresAt: Date.now() + 1000,
				inputSchema: {
					type: "object",
					properties: { approved: { type: "boolean" } },
					required: ["approved"],
					additionalProperties: false,
				},
			},
			result: null,
		},
	];
	const fitted = fitTaskOffer(tasks);
	const base = estimateJsonTokens(analysisTools([], new Set(), true));
	expect(
		estimateJsonTokens(taskOfferProjection(fitted)) +
			estimateJsonTokens(analysisTools([], new Set(), true, fitted)) -
			base,
	).toBeLessThanOrEqual(1024);
	const answer = (workRef: string, expectedRevision: number) =>
		analysisReceipt("answer", {
			name: "task_control",
			args: {
				workRef,
				expectedRevision,
				action: "answer",
				questionRef: questionId,
				input: { approved: true },
			},
		});
	expect(
		validateAnalysis(answer(id, 2).toolCalls!, [], true, fitted),
	).toMatchObject({
		next: "task_control",
		control: {
			workRef: id,
			expectedRevision: 2,
			action: "answer",
			input: { approved: true },
		},
	});
	expect(() =>
		validateAnalysis(
			answer(crypto.randomUUID(), 2).toolCalls!,
			[],
			true,
			fitted,
		),
	).toThrow();
	expect(() =>
		validateAnalysis(answer(id, 1).toolCalls!, [], true, fitted),
	).toThrow();
});

test("a pipeline's run is never amended: the call goes back for the structural repair; cancel still works", () => {
	const tasks = offer(),
		id = crypto.randomUUID();
	tasks.works = [
		{
			id,
			conversationId: "main",
			request: "茹で時間を調べてタイマーと曲",
			revision: 0,
			status: "waiting_child",
			deadline: Date.now() + 1000,
			question: null,
			result: null,
			pipeline: true,
		},
	];
	const control = (action: "amend" | "cancel") =>
		analysisReceipt("control", {
			name: "task_control",
			args: {
				workRef: id,
				expectedRevision: 0,
				action,
				...(action === "amend" ? { request: "5分にして" } : {}),
			},
		}).toolCalls!;
	expect(() => validateAnalysis(control("amend"), [], true, tasks)).toThrow();
	expect(validateAnalysis(control("cancel"), [], true, tasks)).toMatchObject({
		next: "task_control",
		control: { action: "cancel" },
	});
	expect(taskOfferProjection(tasks).works[0]).toMatchObject({ pipeline: true });
});
