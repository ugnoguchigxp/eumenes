import { analysisHandler } from "./analysis-handler";
import { active, digest, frame, valid } from "./analysis-source";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { imageForInput } from "../../../infrastructure/media-image";
import type { QueueService } from "../../queue";
import {
	analysisCreate,
	type AnalysisCreate,
	type AnalysisRecord,
	type PerceptionPort,
} from "../../larm";
import { owned, record } from "../repository";
import {
	analysisRow,
	analysisRecord,
	updateAnalysis,
	analysisRows,
	type AnalysisRow,
} from "../repository/analyses";
export function createRecognitionAnalyses(deps: {
	store: SqliteStore;
	queue: QueueService;
	visual: () => PerceptionPort;
}) {
	const { store, queue, visual } = deps;
	const checked = (
		db: Database,
		owner: string,
		sourceId: string,
		id: string,
	) => {
		owned(db, sourceId, owner);
		const r = analysisRow(db, id);
		if (!r || r.owner !== owner || r.source_id !== sourceId)
			throw new Error("analysis_not_found");
		return r;
	};
	queue.registerHandler(analysisHandler(store, visual));
	function removeInTransaction(db: Database, sourceId: string) {
		const rows = db
			.query("SELECT * FROM object_recognition_analyses WHERE source_id=?")
			.all(sourceId) as AnalysisRow[];
		for (const r of rows)
			if (r.job_id && active(analysisRecord(r)))
				queue.cancelInTransaction(db, r.job_id, "source_deleted");
		db.query("DELETE FROM object_recognition_analyses WHERE source_id=?").run(
			sourceId,
		);
		return rows.flatMap((r) => (r.job_id ? [r.job_id] : []));
	}
	return {
		async recover() {
			const pending = store.read(
				(db) =>
					db
						.query(
							"SELECT * FROM object_recognition_analyses WHERE connection_id IS NOT NULL AND (json_extract(record_json,'$.releaseConfirmed') IS NULL OR json_extract(record_json,'$.releaseConfirmed') = 0 OR json_extract(record_json,'$.stopObservation.status') = 'observing')",
						)
						.all() as AnalysisRow[],
			);
			for (const r of pending) {
				const v = analysisRecord(r);
				const port = visual();
				let released = false;
				if (v.releaseConfirmed === true) released = true;
				else if (port.version() === v.settingsVersion)
					try {
						await port.release(r.connection_id!);
						released = true;
					} catch {}
				await store.write((db) => {
					const current = analysisRow(db, r.id);
					if (!current) return;
					const c = analysisRecord(current);
					updateAnalysis(db, current, {
						releaseConfirmed: released,
						stopObservation: {
							...c.stopObservation,
							connectionId: r.connection_id!,
							status: "unconfirmed",
							reason: "observation_interrupted",
							checkedAt: Date.now(),
						},
						...(active(c)
							? {
									state: "failed" as const,
									errorCode: "analysis_interrupted",
									result: null,
								}
							: {}),
					});
				});
			}
		},
		async create(owner: string, sourceId: string, input: AnalysisCreate) {
			const v = analysisCreate.parse(input);
			return store.write((db) => {
				const src = owned(db, sourceId, owner);
				if (src.conversation_id !== v.conversationId)
					throw new Error("analysis_not_found");
				const prior = analysisRow(db, v.requestId);
				if (prior) {
					checked(db, owner, sourceId, v.requestId);
					if (prior.input_json !== JSON.stringify(v))
						throw new Error("request_conflict");
					return analysisRecord(prior);
				}
				const source = record(src);
				if (source.revision !== v.expectedRevision)
					throw new Error("revision_conflict");
				const timestamp = frame(src, v.frameIndex);
				if (
					analysisRows(db, sourceId).some(
						(r) =>
							r.frame_key === (v.frameIndex ?? -1) && active(analysisRecord(r)),
					)
				)
					throw new Error("analysis_busy");
				const now = Date.now();
				const r: AnalysisRecord = {
					id: v.requestId,
					sourceId,
					sourceRevision: source.revision,
					frameIndex: v.frameIndex ?? null,
					timestamp,
					actualTimestamp: null,
					sourceDigest: digest(src),
					settingsVersion: visual().version(),
					options: {
						task: v.task,
						query: v.query,
						maxNewTokens: v.maxNewTokens,
					},
					state: "queued",
					result: null,
					errorCode: null,
					releaseConfirmed: null,
					waitingMs: null,
					inferenceMs: null,
					elapsedMs: null,
					createdAt: now,
					updatedAt: now,
				};
				db.query(
					"INSERT INTO object_recognition_analyses(id,source_id,owner,conversation_id,frame_key,record_json,input_json) VALUES(?,?,?,?,?,?,?)",
				).run(
					r.id,
					sourceId,
					owner,
					v.conversationId,
					v.frameIndex ?? -1,
					JSON.stringify(r),
					JSON.stringify(v),
				);
				const job = queue.enqueueInTransaction(db, {
					scope: "object-recognition",
					kind: "object-recognition.analysis",
					dedupeKey: r.id,
					payload: { id: r.id },
					subjectRef: r.id,
					lane: "interactive",
					resourceKey: "vision.perception",
					concurrencyKey: "vision.perception",
					availableAtMs: now,
					deadlineAtMs: now + 360000,
					maxAttempts: 1,
				});
				db.query(
					"UPDATE object_recognition_analyses SET job_id=? WHERE id=?",
				).run(job.job.id, r.id);
				return r;
			});
		},
		list(
			owner: string,
			sourceId: string,
			conversationId: string,
			frameIndex?: number,
		) {
			return store.read((db) => {
				const src = owned(db, sourceId, owner);
				if (src.conversation_id !== conversationId)
					throw new Error("analysis_not_found");
				return analysisRows(db, sourceId)
					.filter((r) => r.frame_key === (frameIndex ?? -1))
					.map(analysisRecord);
			});
		},
		get(owner: string, sourceId: string, id: string, conversationId: string) {
			return store.read((db) => {
				const r = checked(db, owner, sourceId, id);
				if (r.conversation_id !== conversationId)
					throw new Error("analysis_not_found");
				return analysisRecord(r);
			});
		},
		async cancel(
			owner: string,
			sourceId: string,
			id: string,
			conversationId: string,
		) {
			const job = await store.write((db) => {
				const r = checked(db, owner, sourceId, id);
				if (r.conversation_id !== conversationId)
					throw new Error("analysis_not_found");
				if (r.job_id && active(analysisRecord(r)))
					queue.cancelInTransaction(db, r.job_id, "cancel_requested");
				return r.job_id;
			});
			if (job) queue.flushCancellations([job]);
			return this.get(owner, sourceId, id, conversationId);
		},
		async image(
			owner: string,
			sourceId: string,
			id: string,
			conversationId: string,
			signal: AbortSignal,
		) {
			const v = this.get(owner, sourceId, id, conversationId);
			const bytes = store.read((db) => {
				const r = checked(db, owner, sourceId, id);
				if (!valid(db, r)) throw new Error("analysis_source_changed");
				return owned(db, sourceId, owner).bytes;
			});
			return imageForInput(
				bytes,
				v.timestamp,
				signal,
				["image/png", "image/jpeg"],
				4194304,
				4194304,
			);
		},
		removeInTransaction,
	};
}
