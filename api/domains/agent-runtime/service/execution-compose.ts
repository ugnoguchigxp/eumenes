import type {
	AuthoringOutcome,
	ComponentRecord,
	InferencePort as ComposerPort,
} from "eumenes-pipeline";
import { estimateMessageTokens, type Receipt } from "../../inference";
import type { HandlerDefinition } from "../../queue";
import { checkPipelineDefinition, parsePipelineOutcome } from "../../pipelines";
import { saveExecution } from "../repository/executions";
import { executionPayload } from "./execution-step";
import { PIPELINE_COMPOSE, type ExecutionContext } from "./execution-context";
import type { ExecutionOps } from "./execution-store";
import type { ExecutionPipeline } from "./execution-pipeline";
type Input = {
	executionId: string;
	requestId: string;
	request: string;
	catalog: ComponentRecord[];
	messages: Array<{ role: "system" | "user"; content: string }>;
	sourceRefs: {
		conversationId: string;
		messageIds: string[];
		itemIds: string[];
	};
};
type Output = {
	receipt: Receipt;
	outcome?: AuthoringOutcome;
	invalid?: { output: string; issues: string };
};
/** LARM is the imported inference port's transport; its receipt stays under the existing revocation contract. */
export function executionCompose(
	ctx: ExecutionContext,
	ops: ExecutionOps,
	pipeline: ExecutionPipeline,
): HandlerDefinition<
	{ id: string; epoch: number; ordinal: number },
	Input,
	Output
> {
	return {
		kind: PIPELINE_COMPOSE,
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
			if (
				!current ||
				current.row.state !== "queued" ||
				!current.state.pipeline ||
				current.state.pipeline.executionPlan
			)
				return { status: "stale", reason: "execution_changed" };
			const { row, state, source } = current,
				p = state.pipeline!;
			if (
				state.calls >= state.limits.parentCalls ||
				state.consumed >= state.limits.modelCalls
			) {
				ops.fail(db, row, state, "execution_budget_exceeded");
				return { status: "stale", reason: "execution_budget_exceeded" };
			}
			const messages: Input["messages"] = [
				{ role: "system", content: state.instructions },
				{
					role: "user",
					content: JSON.stringify({
						request: source.request,
						providedMaterials: state.refs
							.filter((r) => p.initialRefs.includes(r.ref))
							.map((r) => ({
								ref: r.ref,
								label: r.label,
								kind: r.kind,
								preview: r.preview,
							})),
						answers: source.responses ?? [],
						cards: p.catalog.map((r) => r.card),
						...(p.correction
							? { contractErrors: p.correction, previousOutput: p.draft }
							: {}),
					}),
				},
			];
			const window = ctx.inference.savedLlmContextWindow?.();
			if (window && estimateMessageTokens(messages) + 8192 > window) {
				ops.fail(db, row, state, "execution_context_capacity");
				return { status: "stale", reason: "execution_context_capacity" };
			}
			if (
				!ctx.inference.captureUserControlInTransaction ||
				!ctx.inference.executeStream
			)
				throw new Error("control_unavailable");
			const requestId = ctx.inference.captureUserControlInTransaction(db, {
				subject: `execution:${row.id}-compose-${state.calls}`,
				route: "subagent",
				deadline: Math.min(row.deadline, ctx.now() + 45000),
				maxOutputTokens: 8192,
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
					request: source.request,
					catalog: p.catalog,
					messages,
					sourceRefs: {
						conversationId: source.conversationId,
						messageIds: [
							source.messageId,
							...(source.responses ?? []).map((r) => r.messageId),
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
			let receipt: Receipt | undefined;
			const port: ComposerPort = {
				async complete(request) {
					const started = performance.now();
					receipt = await ctx.inference.executeStream!(
						input.requestId,
						[
							{ role: "system", content: request.system ?? "" },
							{ role: "user", content: request.prompt },
						],
						signal,
						() => {},
						undefined,
						[],
						{
							sessionRole: "subagent",
							taskId: input.executionId,
							agentSession: {
								conversationId: input.sourceRefs.conversationId,
								agentId: input.executionId,
							},
							refs: input.sourceRefs,
							outputLimit: 8192,
						},
					).finally(() =>
						ctx.inference.releaseTaskSession?.(input.executionId),
					);
					return {
						ok: true,
						text:
							typeof receipt.value === "string"
								? receipt.value
								: new TextDecoder().decode(receipt.value),
						model: null,
						usage: {
							inputTokens: null,
							outputTokens: null,
							cachedTokens: null,
							reasoningTokens: null,
							calls: null,
						},
						durationMs: performance.now() - started,
					};
				},
			};
			const result = await port.complete({
				purpose: "compose",
				system: input.messages[0]!.content,
				prompt: input.messages[1]!.content,
			});
			if (!result.ok || !receipt) throw new Error("pipeline_inference_failed");
			let raw: unknown;
			try {
				raw = JSON.parse(result.text);
			} catch {
				return {
					receipt,
					invalid: { output: result.text, issues: "invalid_json" },
				};
			}
			const parsed = parsePipelineOutcome(raw);
			if (!parsed.success)
				return {
					receipt,
					invalid: {
						output: result.text,
						issues: parsed.error.issues
							.map((i) => `${i.path.join(".")}:${i.code}`)
							.join("\n")
							.slice(0, 4000),
					},
				};
			if (parsed.data.status === "ready") {
				const check = checkPipelineDefinition(
					parsed.data.definition,
					input.catalog,
					input.request,
				);
				if (!check.ok)
					return {
						receipt,
						invalid: {
							output: result.text,
							issues: check.issues
								.map((i) => `${i.path}:${i.code}`)
								.join("\n")
								.slice(0, 4000),
						},
					};
			}
			return { receipt, outcome: parsed.data };
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
			const { row, state } = current,
				p = state.pipeline!;
			if (outcome.type !== "success") {
				ops.fail(
					db,
					row,
					state,
					"errorCode" in outcome ? outcome.errorCode : "deadline_exceeded",
				);
				return "applied";
			}
			if (!ctx.inference.acceptInTransaction?.(db, outcome.result.receipt)) {
				ops.fail(db, row, state, "permission_revoked");
				return "applied";
			}
			state.activeRequestId = undefined;
			if (outcome.result.invalid) {
				if (p.repaired) {
					pipeline.stop(db, row, state, "pipeline_definition_invalid");
					return "applied";
				}
				p.repaired = true;
				p.correction = outcome.result.invalid.issues;
				p.draft = outcome.result.invalid.output;
				ops.enqueue(db, row, state);
				return "applied";
			}
			p.draft = undefined;
			pipeline.composed(db, row, state, outcome.result.outcome!);
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
