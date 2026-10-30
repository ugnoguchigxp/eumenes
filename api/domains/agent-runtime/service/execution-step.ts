import { z } from "zod";
import type { ToolchainCard } from "../../capabilities";
import type { Receipt } from "../../inference";
import { estimateJsonTokens, estimateMessageTokens } from "../../inference";
import type { HandlerDefinition } from "../../queue";
import type { ExecutionSource, ParentDecision } from "../../tool-runtime";
import { executionObservations, saveExecution } from "../repository/executions";
import { PARENT_STEP, type ExecutionContext } from "./execution-context";
import { executionMessages } from "./execution-prompt";
import type { ExecutionOps } from "./execution-store";
import { acceptExecutionPlan } from "./execution-plan";
import {
	executionTools,
	executionResultRefs,
	finishExecution,
	parseExecutionDecision,
	executionRepair,
} from "./execution-tools";

export const executionPayload = z.strictObject({
	id: z.uuid(),
	epoch: z.number().int(),
	ordinal: z.number().int(),
});
type Payload = z.infer<typeof executionPayload>;
type StepInput = {
	executionId: string;
	source: ExecutionSource;
	requestId: string;
	cards: ToolchainCard[];
	tools: ReturnType<typeof executionTools>;
	messages: ReturnType<typeof executionMessages>;
	refs: string[];
	resultRefs: string[];
	sourceRefs: {
		messageIds: string[];
		itemIds: string[];
		conversationId: string;
	};
};
type StepOutput = {
	receipt: Receipt;
	decision: ParentDecision;
	candidates?: string[];
	searchFailed?: boolean;
};
export function executionStep(
	ctx: ExecutionContext,
	ops: ExecutionOps,
): HandlerDefinition<Payload, StepInput, StepOutput> {
	return {
		kind: PARENT_STEP,
		payloadVersions: [1],
		schema: executionPayload,
		recovery: "interrupt",
		resourceKey: "inference.llm",
		prepareInTransaction(db, claim) {
			const current = ops.active(
				db,
				claim.payload.id,
				claim.payload.epoch,
				claim.payload.ordinal,
			);
			if (!current || current.row.state !== "queued")
				return { status: "stale", reason: "execution_changed" };
			const { row, state, source } = current;
			if (
				state.calls >= state.limits.parentCalls ||
				state.consumed >= state.limits.modelCalls
			) {
				ops.fail(db, row, state, "execution_budget_exceeded");
				return { status: "stale", reason: "execution_budget_exceeded" };
			}
			const port = ctx.port();
			let cards = state.offered.flatMap((id) => {
				const card = port.cardInTransaction(db, id);
				return card ? [card] : [];
			});
			if (!state.selecting)
				while (
					cards.length &&
					estimateJsonTokens(
						cards.map((c) => ({ ...c, instant: c.instant?.parameters })),
					) > 4096
				)
					cards.pop();
			const tools = executionTools(
				state,
				cards,
				ctx.now() >= row.deadline - 45_000,
			);
			const messages = executionMessages(
				row,
				state,
				source,
				executionObservations(db, row.id),
			);
			const window = ctx.inference.savedLlmContextWindow?.();
			if (
				window &&
				estimateMessageTokens(messages) + estimateJsonTokens(tools) + 2048 >
					window
			) {
				ops.fail(db, row, state, "execution_context_capacity");
				return { status: "stale", reason: "execution_context_capacity" };
			}
			if (
				!ctx.inference.captureUserControlInTransaction ||
				!ctx.inference.executeStream
			)
				throw new Error("control_unavailable");
			const requestId = ctx.inference.captureUserControlInTransaction(db, {
				subject: `execution:${row.id}-${state.calls}`,
				deadline: Math.min(row.deadline, ctx.now() + 45_000),
				maxOutputTokens: 2048,
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
					source,
					requestId,
					cards,
					tools,
					messages,
					refs: state.refs.map((r) => r.ref),
					resultRefs: executionResultRefs(state),
					sourceRefs: {
						conversationId: source.conversationId,
						messageIds: [
							source.messageId,
							...(source.amendments ?? []).map((update) => update.messageId),
							...(source.responses ?? []).map((update) => update.messageId),
							...state.refs
								.filter((r) => r.kind === "message")
								.map((r) => r.id),
						],
						itemIds: state.refs
							.filter((r) => r.kind === "memory")
							.map((r) => r.id),
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
				},
			).finally(() => ctx.inference.releaseTaskSession?.(input.executionId));
			let decision: ParentDecision;
			try {
				decision = parseExecutionDecision(
					receipt.toolCalls,
					input.tools,
					input.cards,
					input.refs,
					input.resultRefs,
				);
			} catch (error) {
				const known = [
					"execution_call_count",
					"execution_tool_not_offered",
					"execution_arguments_invalid",
					"execution_reference_not_offered",
					"execution_completion_incomplete",
					"execution_completion_unreferenced",
					"execution_step_not_offered",
					"execution_plan_invalid",
					"execution_plan_arguments_invalid",
				];
				const code =
					error instanceof Error && known.includes(error.message)
						? error.message
						: "execution_arguments_invalid";
				throw new Error(`execution_invalid_decision_${code}`);
			}
			if (decision.name !== "find_toolchain") return { receipt, decision };
			try {
				const cards = await ctx
					.port()
					.find(decision.arguments.query as string, input.source, signal);
				return {
					receipt,
					decision,
					// The search bounds the candidates by its slots (the toolchain search and choice design, section 3).
					candidates: cards.map((c) => c.revisionId),
				};
			} catch {
				signal.throwIfAborted();
				return { receipt, decision, searchFailed: true };
			}
		},
		classify: () => "fail",
		settleInTransaction(db, claim, input, outcome) {
			const current = ops.active(
				db,
				claim.payload.id,
				claim.payload.epoch,
				claim.payload.ordinal,
			);
			if (!current) return "stale";
			const { row, state, source } = current;
			if (outcome.type !== "success") {
				if (state.activeRequestId)
					ctx.inference.cancelRequestsInTransaction?.(db, [
						state.activeRequestId,
					]);
				state.activeRequestId = undefined;
				if (
					outcome.type !== "failed" ||
					!outcome.errorCode.startsWith("execution_invalid_decision_") ||
					state.correction ||
					state.calls >= state.limits.parentCalls
				)
					ops.fail(
						db,
						row,
						state,
						"errorCode" in outcome ? outcome.errorCode : "deadline_exceeded",
					);
				else {
					state.correction = executionRepair(
						outcome.errorCode.slice("execution_invalid_decision_".length),
					);
					ops.enqueue(db, row, state);
				}
				return "applied";
			}
			if (!ctx.inference.acceptInTransaction?.(db, outcome.result.receipt)) {
				ops.fail(db, row, state, "permission_revoked");
				return "applied";
			}
			state.activeRequestId = undefined;
			state.correction = undefined;
			const { name, arguments: args } = outcome.result.decision;
			if (name === "complete_task" || name === "report_partial") {
				const result = finishExecution.parse(args);
				ops.finish(
					db,
					row,
					state,
					name === "complete_task" ? "completed" : "partial",
					result,
				);
			} else if (name === "set_plan") {
				acceptExecutionPlan(state, row.request_revision, args);
				ops.enqueue(db, row, state);
			} else if (name === "find_toolchain") {
				state.searches++;
				state.selecting = true;
				state.offered = outcome.result.candidates ?? [];
				if (outcome.result.searchFailed)
					ops.fail(db, row, state, "embedding_unavailable");
				else ops.enqueue(db, row, state);
			} else if (name === "ask_user")
				ops.question(db, row, state, args.question as string);
			else if (name === "read_reference") {
				const ref = state.refs.find((r) => r.ref === args.ref)!;
				const body = ctx
					.port()
					.readReferenceInTransaction(
						db,
						source,
						ref,
						args.start as number,
						args.limit as number,
					);
				state.notes.push({
					id: `read:${state.ordinal}`,
					state: "reference",
					summary: body.slice(0, 2000),
					refs: [ref.ref],
					read: {
						ref: ref.ref,
						start: args.start as number,
						limit: args.limit as number,
					},
				});
				ops.enqueue(db, row, state);
			} else {
				const card = input?.cards.find((c) => c.functionName === name);
				if (!card) throw new Error("execution_tool_not_offered");
				ops.startChild(db, row, state, card.revisionId, args);
			}
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
