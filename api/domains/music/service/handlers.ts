import { parseLlmJson } from "../../../infrastructure/llm-json";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { musicPlan, musicPlanV2, type Prepared } from "../../capabilities";
import type { Receipt } from "../../inference";
import type { HandlerDefinition } from "../../queue";
import type { TestOutput } from "../../larm";
import type { MusicRecord } from "../contracts";
import { row, record, patch } from "../repository";
import { musicContext } from "./context";
import type { createMusic } from "./index";
const payload = z.object({ id: z.string() });
const active = (r: MusicRecord) =>
	r.state === "planning" || r.state === "generating";
const safeError = (error: unknown) =>
	error instanceof Error && /^[a-z_0-9]{1,80}$/.test(error.message)
		? error.message
		: "music_generation_failed";
export function registerMusicHandlers(
	deps: Parameters<typeof createMusic>[0] & {
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
		context: ReturnType<typeof musicContext>;
	};
	const planHandler: HandlerDefinition<
		{ id: string },
		PlanInput,
		{ receipt: Receipt; plan: z.infer<typeof musicPlanV2> }
	> = {
		kind: "music.plan",
		payloadVersions: [1],
		schema: payload,
		recovery: "interrupt",
		resourceKey: "inference.llm",
		prepareInTransaction(db, claim) {
			const r = row(db, claim.payload.id);
			if (!r || record(r).state !== "planning")
				return { status: "stale", reason: "music_not_planning" };
			if (!inference.captureControlInTransaction || !inference.executeControl)
				throw new Error("music_inference_unavailable");
			const prepared = JSON.parse(r.bindings_json) as Prepared;
			capabilities.validateInTransaction(db, prepared);
			const requestId = inference.captureControlInTransaction(db, {
				subject: `music:${r.id}:plan`,
				policySubject: r.run_id,
				deadline: Math.min(r.deadline - 15000, Date.now() + 45000),
				maxOutputTokens: prepared.package.revision >= 2 ? 4096 : 2048,
			});
			return {
				status: "ready",
				input: {
					id: r.id,
					requestId,
					prepared,
					context: musicContext(prepared, JSON.parse(r.request_json)),
				},
			};
		},
		async execute(input, { signal }) {
			const receipt = await inference.executeControl!(
				input.requestId,
				input.context.messages,
				signal,
				input.context.control,
			);
			let value: unknown;
			try {
				value = parseLlmJson(receipt.value);
			} catch {
				throw new Error("music_plan_invalid_json");
			}
			const schema =
				input.prepared.package.revision >= 2 ? musicPlanV2 : musicPlan;
			const parsed = schema.safeParse(value);
			if (!parsed.success) throw new Error("music_plan_invalid_contract");
			return { receipt, plan: { instrumental: true, ...parsed.data } };
		},
		classify: () => "fail",
		settleInTransaction(db, claim, input, outcome) {
			const r = row(db, claim.payload.id);
			if (!r || record(r).state !== "planning") return "stale";
			if (outcome.type !== "success" || !input) {
				fail(
					db,
					r.id,
					"errorCode" in outcome ? outcome.errorCode : "music_plan_interrupted",
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
				fail(db, r.id, "music_plan_invalidated");
				return "applied";
			}
			const plan = outcome.result.plan;
			db.query("UPDATE music_generations SET plan_json=? WHERE id=?").run(
				JSON.stringify(plan),
				r.id,
			);
			patch(db, r.id, { ...plan, state: "generating", phase: "queued" });
			enqueue(db, r.id, r.run_id, r.deadline, "generate");
			return "applied";
		},
		cancelInTransaction: cancel,
	};
	type GenerateInput = {
		id: string;
		plan: z.infer<typeof musicPlanV2>;
		prepared: Prepared;
	};
	const generateHandler: HandlerDefinition<
		{ id: string },
		GenerateInput,
		TestOutput
	> = {
		kind: "music.generate",
		payloadVersions: [1],
		schema: payload,
		recovery: "interrupt",
		resourceKey: "music.generate",
		prepareInTransaction(db, claim) {
			const r = row(db, claim.payload.id);
			if (!r || record(r).state !== "generating" || !r.plan_json)
				return { status: "stale", reason: "music_not_generating" };
			const prepared = JSON.parse(r.bindings_json) as Prepared;
			capabilities.validateInTransaction(db, prepared);
			return {
				status: "ready",
				input: {
					id: r.id,
					plan: {
						instrumental: true,
						...(prepared.package.revision >= 2 ? musicPlanV2 : musicPlan).parse(
							JSON.parse(r.plan_json),
						),
					},
					prepared,
				},
			};
		},
		async execute(input, { signal }) {
			try {
				const gateway = deps.gateway();
				const catalog = await gateway.catalog(signal);
				const target = catalog.targets.find(
					(t) => t.kind === "music" && t.selector === "SAAA-w-music",
				);
				if (!target) throw new Error("music_service_unavailable");
				const output = await gateway.execute(
					target,
					{
						text: input.plan.prompt,
						durationSeconds: input.plan.durationSeconds,
						instrumental: input.plan.instrumental,
						lyrics: input.plan.instrumental ? undefined : input.plan.lyrics,
						language: input.plan.instrumental ? undefined : input.plan.language,
					},
					signal,
					async (p) => {
						await store.write((db) => {
							const r = row(db, input.id);
							if (!r || !active(record(r)) || signal.aborted) return;
							patch(db, input.id, {
								phase: p.phase,
								...(p.jobId ? { jobId: p.jobId } : {}),
							});
						});
					},
				);
				if (!output.bytes?.length || !output.mime?.startsWith("audio/"))
					throw new Error("music_audio_missing");
				// Bound persistent media storage per track. Existing LARM reads are bounded too.
				if (output.bytes.length > 32 * 1024 * 1024)
					throw new Error("music_audio_too_large");
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
						: "music_generation_interrupted",
				);
				return "applied";
			}
			try {
				capabilities.validateInTransaction(db, input.prepared);
			} catch {
				fail(db, r.id, "capability_revoked");
				return "applied";
			}
			const output = outcome.result;
			db.query("UPDATE music_generations SET audio=? WHERE id=?").run(
				output.bytes!,
				r.id,
			);
			patch(db, r.id, {
				state: "completed",
				phase: "completed",
				mime: output.mime!,
				actualModel: output.actualModel ?? output.artifact?.actualModel ?? null,
			});
			deps.onFinished(db, r.run_id);
			return "applied";
		},
		cancelInTransaction: cancel,
	};
	queue.registerHandler(planHandler);
	queue.registerHandler(generateHandler);
}
