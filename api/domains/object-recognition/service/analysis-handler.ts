import { z } from "zod";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { imageForInput } from "../../../infrastructure/media-image";
import type { HandlerDefinition } from "../../queue";
import type { AnalysisRecord, PerceptionPort } from "../../larm";
import { row } from "../repository";
import {
	analysisRow,
	analysisRecord,
	updateAnalysis,
} from "../repository/analyses";
import { active, valid } from "./analysis-source";
export function analysisHandler(
	store: SqliteStore,
	visual: () => PerceptionPort,
) {
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
		| { ok: false; code: string };
	const handler: HandlerDefinition<{ id: string }, Prepared, Output> = {
		kind: "object-recognition.analysis",
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
			const src = row(db, r.source_id)!;
			updateAnalysis(db, r, { state: "starting" });
			return {
				status: "ready",
				input: {
					bytes: src.bytes,
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
								db.query(
									"UPDATE object_recognition_analyses SET connection_id=? WHERE id=?",
								).run(id!, r.id);
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
						: !outcome.result.ok
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
			if (outcome.type !== "success" || !outcome.result.ok) return "stale";
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
