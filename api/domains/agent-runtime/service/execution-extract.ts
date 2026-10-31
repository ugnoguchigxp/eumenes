import { z } from "zod";
import { parseLlmJson } from "../../../infrastructure/llm-json";
import { systemContext } from "../../../infrastructure/system-context";
import type { Receipt } from "../../inference";
import { expand, valueFault, valueSchemaJson } from "../../pipelines";
import type { HandlerDefinition } from "../../queue";
import { saveExecution } from "../repository/executions";
import { PIPELINE_EXTRACT, type ExecutionContext } from "./execution-context";
import type { ExecutionPipeline } from "./execution-pipeline";
import type { ExecutionOps } from "./execution-store";

const payload = z.strictObject({
	id: z.uuid(),
	epoch: z.number().int(),
	ordinal: z.number().int(),
});
type Payload = z.infer<typeof payload>;
type Input = {
	executionId: string;
	requestId: string;
	messages: Array<{ role: "system" | "user"; content: string }>;
	tools: ReturnType<typeof extractTools>;
	schema: Parameters<typeof valueFault>[0];
	sourceRefs: { conversationId: string; messageIds: string[]; itemIds: [] };
};
const FUNCTION = "extract_value";
/** One value is a short call; its bound keeps a forced call from running on. */
const OUTPUT_TOKENS = 1024;

function extractTools(schema: Parameters<typeof valueSchemaJson>[0]) {
	return [
		{
			type: "function" as const,
			function: {
				name: FUNCTION,
				description: "取り出した値を一つ書きます。",
				parameters: {
					type: "object",
					properties: { value: valueSchemaJson(schema) },
					required: ["value"],
					additionalProperties: false,
				},
			},
		},
	];
}

/**
 * A task pipeline's extract step (spec task-pipeline-design 2026-10-22 §6.3): one inference takes one typed value
 * out of the earlier steps' text. The host checks it against the step's schema; a value that does not fit gets one
 * structural repair, then the run stops.
 */
export function executionExtract(
	ctx: ExecutionContext,
	ops: ExecutionOps,
	pipeline: ExecutionPipeline,
): HandlerDefinition<Payload, Input, { receipt: Receipt; value: unknown }> {
	return {
		kind: PIPELINE_EXTRACT,
		payloadVersions: [1],
		schema: payload,
		recovery: "interrupt",
		resourceKey: "inference.llm",
		prepareInTransaction(db, claim) {
			const current = ops.active(
				db,
				claim.payload.id,
				claim.payload.epoch,
				claim.payload.ordinal,
			);
			const step =
				current?.state.pipeline?.definition.steps[
					current.state.pipeline.cursor
				];
			if (
				!current ||
				current.row.state !== "queued" ||
				step?.kind !== "extract"
			)
				return { status: "stale", reason: "execution_changed" };
			const { row, state, source } = current;
			const p = state.pipeline!;
			if (
				state.calls >= state.limits.parentCalls ||
				state.consumed >= state.limits.modelCalls
			) {
				ops.fail(db, row, state, "execution_budget_exceeded");
				return { status: "stale", reason: "execution_budget_exceeded" };
			}
			let text: string;
			try {
				text = step.from
					.map((t) => expand(t, { inputs: p.inputs, steps: p.values }))
					.join("\n")
					.slice(0, 8000);
			} catch {
				pipeline.stop(db, row, state, "pipeline_reference_missing");
				return { status: "stale", reason: "pipeline_reference_missing" };
			}
			if (
				!ctx.inference.captureUserControlInTransaction ||
				!ctx.inference.executeStream
			)
				throw new Error("control_unavailable");
			const requestId = ctx.inference.captureUserControlInTransaction(db, {
				subject: `execution:${row.id}-extract-${state.calls}`,
				route: "subagent",
				deadline: Math.min(row.deadline, ctx.now() + 45_000),
				maxOutputTokens: OUTPUT_TOKENS,
			});
			state.calls++;
			state.consumed++;
			row.state = "deciding";
			state.activeRequestId = requestId;
			saveExecution(db, row, state, ctx.now());
			return {
				status: "ready",
				input: {
					executionId: row.id,
					requestId,
					schema: step.schema,
					tools: extractTools(step.schema),
					messages: [
						{
							role: "system",
							content: systemContext(
								"agent-runtime.contexts.pipeline-extract.instruction",
								{},
							),
						},
						{
							role: "user",
							content: JSON.stringify({
								instruction: step.instruction,
								schema: valueSchemaJson(step.schema),
								SOURCE_TEXT: text,
								originalRequest: source.request,
								...(p.correction ? { contractError: p.correction } : {}),
							}),
						},
					],
					sourceRefs: {
						conversationId: source.conversationId,
						messageIds: [source.messageId],
						itemIds: [],
					},
				},
			};
		},
		async execute(input, { signal }) {
			const receipt = await ctx.inference.executeStream!(
				input.requestId,
				input.messages,
				signal,
				() => {},
				undefined,
				input.tools,
				{
					sessionRole: "subagent",
					taskId: input.executionId,
					refs: input.sourceRefs,
					toolChoice: "required",
					outputLimit: OUTPUT_TOKENS,
				},
			).finally(() => ctx.inference.releaseTaskSession?.(input.executionId));
			const calls = receipt.toolCalls ?? [];
			if (calls.length !== 1 || calls[0]!.name !== FUNCTION)
				throw new Error("pipeline_extract_invalid_call");
			let args: unknown;
			try {
				args = parseLlmJson(calls[0]!.arguments);
			} catch {
				throw new Error("pipeline_extract_invalid_json");
			}
			const value =
				args && typeof args === "object" && !Array.isArray(args)
					? (args as { value?: unknown }).value
					: undefined;
			const fault = valueFault(input.schema, value);
			if (fault) throw new Error(`pipeline_extract_invalid_${fault}`);
			return { receipt, value };
		},
		classify: () => "fail",
		settleInTransaction(db, claim, _input, outcome) {
			const current = ops.active(
				db,
				claim.payload.id,
				claim.payload.epoch,
				claim.payload.ordinal,
			);
			if (!current) return "stale";
			const { row, state } = current;
			const p = state.pipeline;
			if (!p) return "stale";
			if (outcome.type !== "success") {
				if (state.activeRequestId)
					ctx.inference.cancelRequestsInTransaction?.(db, [
						state.activeRequestId,
					]);
				state.activeRequestId = undefined;
				const code =
					"errorCode" in outcome ? outcome.errorCode : "deadline_exceeded";
				// A value that does not fit gets one repair with the reason; anything else stops the run.
				if (code.startsWith("pipeline_extract_invalid_") && !p.correction) {
					p.correction = code;
					ops.enqueue(db, row, state, false, PIPELINE_EXTRACT);
				} else pipeline.stop(db, row, state, code);
				return "applied";
			}
			if (!ctx.inference.acceptInTransaction?.(db, outcome.result.receipt)) {
				ops.fail(db, row, state, "permission_revoked");
				return "applied";
			}
			state.activeRequestId = undefined;
			pipeline.extracted(db, row, state, outcome.result.value);
			return "applied";
		},
		cancelInTransaction(db, job, reason) {
			const current = ops.active(
				db,
				job.payload.id,
				job.payload.epoch,
				job.payload.ordinal,
			);
			if (current)
				ops.fail(db, current.row, current.state, reason, "interrupted");
		},
	};
}
