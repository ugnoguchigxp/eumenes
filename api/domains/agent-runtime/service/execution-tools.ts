import { z } from "zod";
import type {
	NativeTool,
	NativeToolCall,
} from "../../../infrastructure/chat-stream";
import { parseLlmJson } from "../../../infrastructure/llm-json";
import type { ToolchainCard } from "../../capabilities";
import type { ParentDecision } from "../../tool-runtime";
import type { ParentState } from "../repository/executions";
import {
	executionPlanInput,
	planReady,
	planFinished,
	runnablePlanItems,
	canPlan,
	executedStepRefs,
} from "./execution-plan";

const refs = z.array(z.string().min(1).max(160)).max(32);
export const finishExecution = z.strictObject({
	summary: z.string().trim().min(1).max(2000),
	fulfilled: z.array(z.string().max(300)).max(12),
	missing: z.array(z.string().max(300)).max(12),
	refs,
});
const controls = {
	set_plan: {
		description:
			"最初に、依頼全体の達成条件、一子呼出しごとの小さい操作計画、最終報告の内容を作る。途中の改訂は未実行部分だけを置き換える。実行済みの操作は追加せず、結果を再利用する。予算・期限は戻らない。",
		schema: executionPlanInput,
	},
	find_toolchain: {
		description:
			"今回の目的に必要な能力を探す。上位4候補だけを比較する。検索は操作ではない。",
		schema: z.strictObject({ query: z.string().trim().min(1).max(2000) }),
	},
	read_reference: {
		description:
			"提示された背景または結果の参照の指定範囲を読む。新しい資料や許可を作らない。",
		schema: z.strictObject({
			ref: z.string().min(1).max(160),
			start: z.number().int().min(0),
			limit: z.number().int().min(1).max(2000),
		}),
	},
	ask_user: {
		description:
			"目的を満たすために足りない条件を一つ質問し、回答を待つ。操作の許可は所有domainの確認へ渡す。",
		schema: z.strictObject({ question: z.string().trim().min(1).max(500) }),
	},
	complete_task: {
		description:
			"今回の要求全体を満たした場合だけ終了する。受付・子の終了だけを達成とはしない。実行済み操作はreceiptのrefを必ず含める。",
		schema: finishExecution,
	},
	report_partial: {
		description:
			"続けられない場合、実行済み・不足・未確定を分けて終了する。未取得の結果や未実装の継続を約束しない。",
		schema: finishExecution,
	},
};
const childInput = z.strictObject({
	stepRef: z.string().min(1).max(160),
	contextRefs: refs,
});
/** Result refs are host-issued receipts, distinct from background and range-read notes. */
export const executionResultRefs = (state: ParentState) =>
	state.refs
		.filter(
			(ref) =>
				ref.owner === "agent-runtime" &&
				state.notes.some((note) => note.id === ref.id),
		)
		.map((ref) => ref.ref);
export function executionTools(
	state: ParentState,
	cards: ToolchainCard[],
	finalOnly = false,
): NativeTool[] {
	const availableRefs = state.refs.map((ref) => ref.ref);
	const resultRefs = executionResultRefs(state);
	const steps = runnablePlanItems(state).map((item) => item.stepRef);
	const referenceItems = {
		type: "string",
		minLength: 1,
		maxLength: 160,
		...(availableRefs.length ? { enum: availableRefs } : {}),
	};
	const referenceList = {
		type: "array",
		description:
			"提示されたreference.refだけを選ぶ。URLや資料名を参照IDとして作らない。参照が不要な場合は空配列。",
		items: referenceItems,
		maxItems: availableRefs.length ? 32 : 0,
	};
	const withReferences = (parameters: Record<string, unknown>) => {
		const properties = parameters.properties as Record<string, unknown>;
		return {
			...parameters,
			properties: {
				...properties,
				...(Object.hasOwn(properties, "contextRefs")
					? { contextRefs: referenceList }
					: {}),
				...(Object.hasOwn(properties, "refs") ? { refs: referenceList } : {}),
				...(Object.hasOwn(properties, "ref") ? { ref: referenceItems } : {}),
				...(Object.hasOwn(properties, "stepRef")
					? { stepRef: { type: "string", enum: steps } }
					: {}),
			},
		};
	};
	const final =
		finalOnly ||
		planFinished(state) ||
		state.calls >= state.limits.parentCalls - 1 ||
		state.consumed >= state.limits.modelCalls - 1;
	const functionOf = (
		name: string,
		description: string,
		parameters: Record<string, unknown>,
	): NativeTool => ({
		type: "function",
		function: { name, description, parameters },
	});
	const tools = Object.entries(controls).flatMap(([name, item]) => {
		if (final && name !== "complete_task" && name !== "report_partial")
			return [];
		if (
			!final &&
			!planReady(state) &&
			!["set_plan", "report_partial"].includes(name)
		)
			return [];
		if (name === "set_plan" && state.children >= state.limits.childCalls)
			return [];
		if (name === "set_plan" && !canPlan(state)) return [];
		if (
			name === "find_toolchain" &&
			(state.selecting ||
				state.searches >= state.limits.searches ||
				state.children >= state.limits.childCalls)
		)
			return [];
		if (name === "ask_user" && state.questions >= 3) return [];
		if (name === "read_reference" && !availableRefs.length) return [];
		const schema = z.toJSONSchema(item.schema);
		if (name === "complete_task")
			(
				schema.properties as Record<string, { maxItems?: number }>
			).missing!.maxItems = 0;
		const parameters = withReferences(schema);
		if (name === "set_plan") {
			const properties = parameters.properties as Record<string, any>;
			properties.items.maxItems = state.limits.childCalls - state.children;
			properties.items.minItems = state.plan ? 0 : 1;
			const dependency = properties.items.items.properties.dependsOn.items;
			const executed = executedStepRefs(state);
			dependency.anyOf = executed.length
				? dependency.anyOf.map((option: Record<string, unknown>) =>
						option.type === "string" ? { ...option, enum: executed } : option,
					)
				: dependency.anyOf.filter(
						(option: Record<string, unknown>) => option.type !== "string",
					);
		}
		if (name === "complete_task" && resultRefs.length)
			(parameters.properties as Record<string, unknown>).refs = {
				...referenceList,
				contains: { type: "string", enum: resultRefs },
				minContains: 1,
				minItems: 1,
			};
		return [functionOf(name, item.description, parameters)];
	});
	if (!final && steps.length && state.children < state.limits.childCalls)
		for (const card of cards) {
			if (
				Object.hasOwn(controls, card.functionName) ||
				["execute_task", "task_control"].includes(card.functionName)
			)
				throw new Error("execution_function_conflict");
			const parameters = card.instant
				? {
						type: "object",
						properties: {
							stepRef: z.toJSONSchema(z.string().min(1).max(160)),
							arguments: card.instant.parameters,
							contextRefs: z.toJSONSchema(refs),
						},
						required: ["stepRef", "arguments", "contextRefs"],
						additionalProperties: false,
					}
				: z.toJSONSchema(childInput);
			tools.push(
				functionOf(
					card.functionName,
					[
						card.title,
						card.summary,
						...(card.execution ? [`実行形式: ${card.execution}`] : []),
						...card.useWhen,
					].join("\n"),
					withReferences(parameters),
				),
			);
		}
	return tools;
}
export function parseExecutionDecision(
	calls: NativeToolCall[] | undefined,
	tools: NativeTool[],
	cards: ToolchainCard[],
	availableRefs: readonly string[],
	resultRefs: readonly string[] = [],
): ParentDecision {
	if (calls?.length !== 1) throw new Error("execution_call_count");
	const call = calls[0]!;
	if (!tools.some((t) => t.function.name === call.name))
		throw new Error("execution_tool_not_offered");
	const raw = parseLlmJson(call.arguments);
	let value: Record<string, unknown>;
	if (Object.hasOwn(controls, call.name)) {
		const checked =
			controls[call.name as keyof typeof controls].schema.safeParse(raw);
		if (!checked.success)
			throw new Error(
				call.name === "set_plan"
					? "execution_plan_arguments_invalid"
					: "execution_arguments_invalid",
			);
		value = checked.data;
	} else {
		const card = cards.find((c) => c.functionName === call.name);
		if (!card) throw new Error("execution_tool_not_offered");
		if (card.instant) {
			const input = z
				.strictObject({
					stepRef: z.string().min(1).max(160),
					arguments: z.record(z.string(), z.unknown()),
					contextRefs: refs,
				})
				.parse(raw);
			const checked = card.instant.parse(input.arguments);
			if (!checked.ok) throw new Error("execution_arguments_invalid");
			value = {
				stepRef: input.stepRef,
				arguments: checked.value,
				contextRefs: input.contextRefs,
			};
		} else value = childInput.parse(raw);
	}
	const properties = tools.find((t) => t.function.name === call.name)!.function
		.parameters.properties as Record<string, any>;
	if (value.stepRef && !properties.stepRef.enum.includes(value.stepRef))
		throw new Error("execution_step_not_offered");
	if (call.name === "set_plan") {
		const plan = executionPlanInput.parse(value);
		const executed: string[] =
			properties.items.items.properties.dependsOn.items.anyOf.find(
				(option: Record<string, unknown>) => option.type === "string",
			)?.enum ?? [];
		if (
			plan.items.length < properties.items.minItems ||
			plan.items.length > properties.items.maxItems ||
			plan.items.some((item, index) =>
				item.dependsOn.some((dep) =>
					typeof dep === "number" ? dep >= index : !executed.includes(dep),
				),
			)
		)
			throw new Error("execution_plan_invalid");
	}
	const selected = (value.contextRefs ??
		value.refs ??
		(value.ref ? [value.ref] : [])) as string[];
	if (selected.some((ref) => !availableRefs.includes(ref)))
		throw new Error("execution_reference_not_offered");
	if (call.name === "complete_task" && (value.missing as string[]).length)
		throw new Error("execution_completion_incomplete");
	if (
		call.name === "complete_task" &&
		resultRefs.length &&
		!selected.some((ref) => resultRefs.includes(ref))
	)
		throw new Error("execution_completion_unreferenced");
	return { name: call.name, arguments: value };
}

/** A structural hint contains schema keys only, never the rejected user/provider data. */
export function executionRepair(code: string) {
	const hint = [
		"execution_plan_arguments_invalid",
		"execution_plan_invalid",
	].includes(code)
		? " set_plan takes goal:string, report:string and items whose keys are only request:string, check:string and dependsOn. dependsOn lists earlier indexes within the new items or stepRefs of executed items. Omit stepRef, state and result fields in items: the host owns execution progress."
		: "";
	return `Contract error: ${code}. Return exactly one offered function with valid arguments and only offered references.${hint}`;
}
