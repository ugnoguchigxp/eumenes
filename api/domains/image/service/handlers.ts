import { executionCallSession, type ChildExecution } from "../../tool-runtime";
import { parseLlmJson } from "../../../infrastructure/llm-json";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { imagePlanV2, type Prepared } from "../../capabilities";
import type { Receipt } from "../../inference";
import type { HandlerDefinition } from "../../queue";
import { findServiceTarget, type TestOutput } from "../../larm";
import type { ImageRecord } from "../contracts";
import { row, record, patch } from "../repository";
import { imageContext } from "./context";
import type { createImage } from "./index";
const payload = z.object({ id: z.string() });
const active = (r: ImageRecord) =>
	r.state === "planning" || r.state === "generating";
const safeError = (error: unknown) =>
	error instanceof Error && /^[a-z_0-9]{1,80}$/.test(error.message)
		? error.message
		: "image_generation_failed";
export function registerImageHandlers(
	deps: Parameters<typeof createImage>[0] & {
		enqueue: (
			db: Database,
			id: string,
			runId: string,
			deadline: number,
			stage: "plan" | "generate",
		) => string;
		fail: (db: Database, id: string, code: string) => void;
		cancel: (db: Database, job: { payload: { id: string } }) => void;
	},
) {
	const { store, queue, inference, capabilities, enqueue, fail, cancel } = deps;
	type PlanInput = {
		id: string;
		requestId: string;
		prepared: Prepared;
		execution?: ChildExecution;
		context: ReturnType<typeof imageContext>;
	};
	const planHandler: HandlerDefinition<
		{ id: string },
		PlanInput,
		{ receipt: Receipt; plan: z.infer<typeof imagePlanV2> }
	> = {
		kind: "image.plan",
		payloadVersions: [1],
		schema: payload,
		recovery: "interrupt",
		resourceKey: "inference.llm",
		prepareInTransaction(db, claim) {
			const r = row(db, claim.payload.id);
			if (!r || record(r).state !== "planning")
				return { status: "stale", reason: "image_not_planning" };
			if (!inference.captureControlInTransaction || !inference.executeControl)
				throw new Error("image_inference_unavailable");
			const prepared = JSON.parse(r.bindings_json) as Prepared;
			capabilities.validateInTransaction(db, prepared);
			const execution = JSON.parse(r.request_json).execution;
			if (execution && !deps.validateExecutionInTransaction?.(db, execution))
				throw new Error("execution_changed");
			const capture = {
				subject: `image:${r.id}:plan`,
				policySubject: r.run_id,
				deadline: Math.min(r.deadline - 15000, Date.now() + 45000),
				maxOutputTokens: 4096,
			};
			const requestId = execution
				? inference.captureUserControlInTransaction!(db, {
						...capture,
						subject: `image-task:${r.id}-plan`,
					})
				: inference.captureControlInTransaction(db, capture);
			return {
				status: "ready",
				input: {
					id: r.id,
					requestId,
					execution,
					prepared,
					context: imageContext(prepared, JSON.parse(r.request_json)),
				},
			};
		},
		async execute(input, { signal }) {
			const receipt = await inference.executeControl!(
				input.requestId,
				input.context.messages,
				signal,
				input.context.control,
				input.execution ? executionCallSession(input.execution) : undefined,
			);
			let value: unknown;
			try {
				value = parseLlmJson(receipt.value);
			} catch {
				throw new Error("image_plan_invalid_json");
			}
			const schema = imagePlanV2;
			const parsed = schema.safeParse(value);
			if (!parsed.success) throw new Error("image_plan_invalid_contract");
			if (parsed.data.action === "generate" && !parsed.data.prompt.trim())
				throw new Error("image_prompt_empty");
			return { receipt, plan: parsed.data };
		},
		classify: () => "fail",
		settleInTransaction(db, claim, input, outcome) {
			const r = row(db, claim.payload.id);
			if (!r || record(r).state !== "planning") return "stale";
			if (outcome.type !== "success" || !input) {
				fail(
					db,
					r.id,
					"errorCode" in outcome ? outcome.errorCode : "image_plan_interrupted",
				);
				return "applied";
			}
			try {
				capabilities.validateInTransaction(db, input.prepared);
			} catch {
				fail(db, r.id, "capability_revoked");
				return "applied";
			}
			if (!inference.acceptInTransaction?.(db, outcome.result.receipt)) {
				fail(db, r.id, "image_plan_invalidated");
				return "applied";
			}
			const plan = outcome.result.plan;
			db.query("UPDATE image_generations SET plan_json=? WHERE id=?").run(
				JSON.stringify(plan),
				r.id,
			);
			patch(db, r.id, {
				...plan,
				state: plan.action === "generate" ? "generating" : "completed",
				phase: plan.action === "generate" ? "queued" : "completed",
			});
			if (plan.action === "generate")
				enqueue(db, r.id, r.run_id, r.deadline, "generate");
			else if (!JSON.parse(r.request_json).execution)
				deps.onFinished(db, r.run_id);
			return "applied";
		},
		cancelInTransaction: cancel,
	};
	type GenerateInput = {
		id: string;
		plan: z.infer<typeof imagePlanV2>;
		prepared: Prepared;
		execution?: ChildExecution;
		deadline: number;
	};
	const generateHandler: HandlerDefinition<
		{ id: string },
		GenerateInput,
		TestOutput
	> = {
		kind: "image.generate",
		payloadVersions: [1],
		schema: payload,
		recovery: "interrupt",
		resourceKey: "image.generate",
		prepareInTransaction(db, claim) {
			const r = row(db, claim.payload.id);
			if (!r || record(r).state !== "generating" || !r.plan_json)
				return { status: "stale", reason: "image_not_generating" };
			const prepared = JSON.parse(r.bindings_json) as Prepared;
			capabilities.validateInTransaction(db, prepared);
			return {
				status: "ready",
				input: {
					id: r.id,
					deadline: r.deadline,
					plan: {
						...imagePlanV2.parse(JSON.parse(r.plan_json)),
					},
					prepared,
				},
			};
		},
		async execute(input, { signal }) {
			try {
				if (Date.now() >= input.deadline - 15000)
					throw new Error("deadline_exceeded");
				const gateway = deps.gateway();
				const catalog = await gateway.catalog(signal);
				const target = findServiceTarget(
					catalog.targets,
					"media.image.generate",
					"larm.image-generation.v1",
				);
				if (!target || !target.description?.trim())
					throw new Error("image_service_unavailable");
				store.read((db) =>
					capabilities.validateInTransaction(db, input.prepared),
				);
				signal.throwIfAborted();
				const output = await gateway.execute(
					target,
					{
						text: input.plan.prompt,
						...(input.plan.model ? { model: input.plan.model } : {}),
						width: input.plan.width,
						height: input.plan.height,
						format: input.plan.format,
						seed: input.plan.seed,
					},
					signal,
					async (p) => {
						await store.write((db) => {
							const r = row(db, input.id);
							if (!r || !active(record(r)) || signal.aborted) return;
							patch(db, input.id, {
								phase: p.phase,
								...(p.artifact
									? {
											artifactId: p.artifact.id,
											mime: p.artifact.mime,
											actualModel:
												p.artifact.actualModel ??
												input.plan.model ??
												target.model,
										}
									: {}),
							});
						});
					},
				);
				if (
					!output.artifact ||
					!output.bytes?.length ||
					!output.mime?.startsWith("image/")
				)
					throw new Error("image_content_missing");
				// Bound image reads; persistent media remains owned by LARM.
				if (output.bytes.length > 32 * 1024 * 1024)
					throw new Error("image_content_too_large");
				return output;
			} catch (e) {
				throw new Error(safeError(e));
			}
		},
		classify: () => "fail",
		settleInTransaction(db, claim, input, outcome) {
			const r = row(db, claim.payload.id);
			if (!r || record(r).state !== "generating") return "stale";
			if (outcome.type !== "success" || !input) {
				fail(
					db,
					r.id,
					"errorCode" in outcome
						? outcome.errorCode
						: "image_generation_interrupted",
				);
				return "applied";
			}
			try {
				capabilities.validateInTransaction(db, input.prepared);
			} catch {
				fail(db, r.id, "capability_revoked");
				return "applied";
			}
			if (Date.now() >= r.deadline - 15000) {
				fail(db, r.id, "deadline_exceeded");
				return "applied";
			}
			const output = outcome.result;
			patch(db, r.id, {
				state: "completed",
				phase: "completed",
				artifactId: output.artifact!.id,
				mime: output.mime!,
				actualModel:
					output.actualModel ??
					output.artifact?.actualModel ??
					record(r).actualModel,
			});
			if (!JSON.parse(r.request_json).execution) deps.onFinished(db, r.run_id);
			return "applied";
		},
		cancelInTransaction: cancel,
	};
	queue.registerHandler(planHandler);
	queue.registerHandler(generateHandler);
}
