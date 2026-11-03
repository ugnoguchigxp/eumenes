import { z } from "zod";
import type { SqliteStore } from "../../infrastructure/sqlite";
import { imageForInput } from "../../infrastructure/media-image";
import type { HandlerDefinition, QueueService } from "../../domains/queue";
import {
	isCapacityBusy,
	LARM_CAPACITY_TIMEOUT,
	settleCapacityWait,
	type AnalysisRecord,
	type PerceptionPort,
} from "../../domains/larm";
import type { MediaAnalysisStorage } from "../../infrastructure/media-analysis";
import type { AnalysisCreate } from "../../domains/larm";
export const active = (v: AnalysisRecord) =>
	["queued", "starting", "running", "cancelling"].includes(v.state);
/** How long one detail analysis may take after LARM accepts it. */
export const ANALYSIS_BUDGET_MS = 360_000;
export function analysisHandler(
	store: SqliteStore,
	queue: QueueService,
	visual: () => PerceptionPort,
	storage: MediaAnalysisStorage<AnalysisRecord, AnalysisCreate>,
) {
	const {
		row: analysisRow,
		record: analysisRecord,
		update: updateAnalysis,
		valid,
		scope,
	} = storage;
	type Prepared = {
		bytes: Uint8Array;
		timestamp: number | null;
		id: string;
		options: AnalysisRecord["options"];
		port: PerceptionPort;
	};
	type Output =
		| {
				ok: true;
				value: Awaited<ReturnType<PerceptionPort["perceive"]>>;
				timestamp: number | null;
		  }
		| { ok: false; code: string }
		| { capacityWait: number | null };
	const handler: HandlerDefinition<{ id: string }, Prepared, Output> = {
		kind: `${scope}.analysis`,
		payloadVersions: [1],
		schema: z.object({ id: z.uuid() }),
		recovery: "interrupt",
		resourceKey: "vision.perception",
		prepareInTransaction(db, claim) {
			const r = analysisRow(db, claim.payload.id);
			if (!r || analysisRecord(r).state !== "queued")
				return { status: "stale", reason: "analysis_not_ready" };
			const v = analysisRecord(r);
			const port = visual();
			if (!valid(db, r) || port.version() !== v.settingsVersion) {
				updateAnalysis(db, r, {
					state: "failed",
					errorCode: valid(db, r)
						? "analysis_connection_changed"
						: "analysis_source_changed",
				});
				return { status: "stale", reason: "analysis_source_changed" };
			}
			const bytes = storage.sourceBytes(db, r.source_id);
			updateAnalysis(db, r, { state: "starting" });
			return {
				status: "ready",
				input: {
					bytes,
					timestamp: v.timestamp,
					id: r.id,
					options: v.options,
					port,
				},
			};
		},
		async execute(input, { signal }) {
			try {
				const image = await imageForInput(
					input.bytes,
					input.timestamp,
					signal,
					["image/png", "image/jpeg"],
					4194304,
					4194304,
				);
				if (
					image.width * image.height > 4194304 ||
					Math.max(image.width, image.height) > 8192
				)
					throw new Error("analysis_image_too_large");
				const value = await input.port.perceive(
					image,
					input.options,
					signal,
					async (phase, id, observation) => {
						await store.write((db) => {
							const r = analysisRow(db, input.id);
							if (!r) return;
							if (phase === "connection") {
								storage.setConnection(db, r.id, id!);
								updateAnalysis(db, r, { releaseConfirmed: null });
							} else if (phase === "lifecycle") {
								if (observation)
									updateAnalysis(db, r, { stopObservation: observation });
							} else if (phase === "released" || phase === "release_failed")
								updateAnalysis(db, r, {
									releaseConfirmed: phase === "released",
								});
							else if (analysisRecord(r).state === "starting")
								updateAnalysis(db, r, { state: "running" });
						});
					},
				);
				return { ok: true, value, timestamp: image.timestamp };
			} catch (error) {
				if (isCapacityBusy(error)) return { capacityWait: error.retryAfterMs };
				const message = error instanceof Error ? error.message : "";
				const code =
					/^(analysis_[a-z_]+|larm_http_\d{3}|invalid_[a-z_]+|provider_[a-z_]+|stale_catalog|deadline_exceeded|larm_[a-z_]+)$/.test(
						message,
					)
						? message
						: error instanceof DOMException && error.name === "TimeoutError"
							? "analysis_timeout"
							: message === "ocr_correction_image_too_large"
								? "analysis_image_too_large"
								: "analysis_failed";
				return { ok: false, code };
			}
		},
		classify: () => "fail",
		settleInTransaction(db, claim, _input, outcome) {
			const r = analysisRow(db, claim.payload.id);
			if (!r) return "stale";
			const v = analysisRecord(r);
			if (!active(v)) return "stale";
			if (v.state === "cancelling") {
				updateAnalysis(db, r, { state: "cancelled", result: null });
				return "applied";
			}
			const failure: string | null = !valid(db, r)
				? "analysis_source_changed"
				: visual().version() !== v.settingsVersion
					? "analysis_connection_changed"
					: outcome.type !== "success"
						? "analysis_interrupted"
						: "ok" in outcome.result && !outcome.result.ok
							? outcome.result.code
							: null;
			if (failure) {
				updateAnalysis(db, r, {
					state: "failed",
					errorCode: failure,
					result: null,
				});
				return { status: "failed", errorCode: failure };
			}
			if (outcome.type !== "success") return "stale";
			if ("capacityWait" in outcome.result) {
				const waiting = settleCapacityWait({
					domain: scope,
					subjectId: r.id,
					now: Date.now(),
					previous: v.capacityWait,
					retryAfterMs: outcome.result.capacityWait,
					budgetMs: ANALYSIS_BUDGET_MS,
					expire: () =>
						updateAnalysis(db, r, {
							state: "failed",
							errorCode: LARM_CAPACITY_TIMEOUT,
							result: null,
						}),
					schedule(wait) {
						const next = queue.enqueueInTransaction(db, {
							scope,
							kind: `${scope}.analysis`,
							dedupeKey: `${r.id}:analysis:w${wait.count}`,
							payload: { id: r.id },
							subjectRef: r.id,
							lane: "interactive",
							resourceKey: "vision.perception",
							concurrencyKey: "vision.perception",
							availableAtMs: wait.at,
							deadlineAtMs: wait.deadline,
							maxAttempts: 1,
						});
						storage.setJob(db, r.id, next.job.id);
						updateAnalysis(db, r, {
							state: "queued",
							capacityWait: { startedAt: wait.startedAt, count: wait.count },
							errorCode: null,
						});
						return next.job.id;
					},
				});
				return waiting
					? "applied"
					: { status: "failed", errorCode: LARM_CAPACITY_TIMEOUT };
			}
			if (!outcome.result.ok) return "stale";
			const { value, timestamp } = outcome.result;
			updateAnalysis(db, r, {
				state: "completed",
				result: value.result,
				actualTimestamp: timestamp,
				waitingMs: value.waitingMs,
				inferenceMs: value.inferenceMs,
				elapsedMs: value.elapsedMs,
				releaseConfirmed: value.releaseConfirmed,
				errorCode: null,
			});
			return "applied";
		},
		cancelInTransaction(db, job) {
			const r = analysisRow(db, job.payload.id);
			if (!r || !active(analysisRecord(r))) return;
			const running = analysisRecord(r).state !== "queued";
			updateAnalysis(db, r, {
				state: "cancelled",
				result: null,
				releaseConfirmed: running ? analysisRecord(r).releaseConfirmed : true,
			});
		},
	};

	return handler;
}
