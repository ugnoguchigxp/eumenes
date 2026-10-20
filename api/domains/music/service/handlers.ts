import { parseLlmJson } from "../../../infrastructure/llm-json";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { musicPlanV3, type Prepared } from "../../capabilities";
import type { Receipt } from "../../inference";
import type { HandlerDefinition } from "../../queue";
import { findServiceTarget, type TestOutput } from "../../larm";
import type { MusicRecord } from "../contracts";
import { row, record, patch } from "../repository";
import { musicContext, musicSchema } from "./context";
import type { createMusic } from "./index";
type GenerationPlan = Omit<z.infer<typeof musicPlanV3>, "task"> & {
	task?: "music" | "sound-effect";
};
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
		{ receipt: Receipt; plan: GenerationPlan }
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
			const messages = [...input.context.messages];
			if (input.prepared.package.revision >= 3) {
				const providers = await deps.gateway().musicProviders(signal);
				messages.push({
					role: "user",
					content: JSON.stringify({ musicProviders: providers }),
				});
			}
			const receipt = await inference.executeControl!(
				input.requestId,
				messages,
				signal,
				input.context.control,
			);
			let value: unknown;
			try {
				value = parseLlmJson(receipt.value);
			} catch {
				throw new Error("music_plan_invalid_json");
			}
			const schema = musicSchema(input.prepared);
			const parsed = schema.safeParse(value);
			if (!parsed.success) throw new Error("music_plan_invalid_contract");
			return {
				receipt,
				plan: parsed.data,
			};
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
		plan: GenerationPlan;
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
						...musicSchema(prepared).parse(JSON.parse(r.plan_json)),
					},
					prepared,
				},
			};
		},
		async execute(input, { signal }) {
			try {
				const gateway = deps.gateway();
				const catalog = await gateway.catalog(signal);
				const target = findServiceTarget(
					catalog.targets,
					"media.music.generate",
				);
				if (!target) throw new Error("music_service_unavailable");
				const output = await gateway.execute(
					target,
					{
						text: input.plan.prompt,
						task: input.plan.task,
						instrumental:
							input.plan.task === "sound-effect"
								? undefined
								: input.plan.instrumental,
						durationSeconds: input.plan.durationSeconds,
						lyrics: input.plan.lyrics,
						language: input.plan.language,
						outputFormat: input.plan.outputFormat,
						quality: input.plan.quality,
						bpm: input.plan.bpm,
						key: input.plan.key,
						timeSignature: input.plan.timeSignature,
						seed: input.plan.seed,
						providerOptions: input.plan.providerOptions,
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
				// Up to 600s of stereo 48kHz 32-bit PCM plus container headers fits in 256 MiB.
				// Keep the same bound as the LARM audio read; never shorten requested audio.
				if (output.bytes.length > 256 * 1024 * 1024)
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
				...(output.durationSeconds !== undefined
					? { durationSeconds: output.durationSeconds }
					: {}),
				...(output.runtime ? { runtime: output.runtime } : {}),
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
