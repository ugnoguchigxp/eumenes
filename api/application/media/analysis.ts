import {
	ANALYSIS_BUDGET_MS,
	analysisHandler,
	active,
} from "./analysis-handler";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../infrastructure/sqlite";
import { imageForInput } from "../../infrastructure/media-image";
import type { QueueService } from "../../domains/queue";
import {
	analysisCreate,
	type AnalysisCreate,
	type AnalysisRecord,
	type PerceptionPort,
} from "../../domains/larm";
import type {
	MediaAnalysisFactory,
	MediaAnalysisStorage,
} from "../../infrastructure/media-analysis";
function createMediaAnalyses(deps: {
	store: SqliteStore;
	queue: QueueService;
	visual: () => PerceptionPort;
	storage: MediaAnalysisStorage<AnalysisRecord, AnalysisCreate>;
}) {
	const { store, queue, visual, storage } = deps;
	const {
		row: analysisRow,
		record: analysisRecord,
		update: updateAnalysis,
		rows: analysisRows,
		valid,
		scope,
	} = storage;
	const checked = (
		db: Database,
		owner: string,
		sourceId: string,
		id: string,
	) => {
		storage.source(db, owner, sourceId);
		const r = analysisRow(db, id);
		if (!r || r.owner !== owner || r.source_id !== sourceId)
			throw new Error("analysis_not_found");
		return r;
	};
	queue.registerHandler(analysisHandler(store, queue, visual, storage));
	function removeInTransaction(db: Database, sourceId: string) {
		const rows = storage.allRows(db, sourceId);
		for (const r of rows)
			if (r.job_id && active(analysisRecord(r)))
				queue.cancelInTransaction(db, r.job_id, "source_deleted");
		storage.deleteSource(db, sourceId);
		return rows.flatMap((r) => (r.job_id ? [r.job_id] : []));
	}
	return {
		async recover() {
			const pending = store.read((db) => storage.pending(db));
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
						...(active(c) && !(c.state === "queued" && c.capacityWait)
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
				const src = storage.source(db, owner, sourceId);
				if (src.conversationId !== v.conversationId)
					throw new Error("analysis_not_found");
				const prior = analysisRow(db, v.requestId);
				if (prior) {
					checked(db, owner, sourceId, v.requestId);
					if (prior.input_json !== JSON.stringify(v))
						throw new Error("request_conflict");
					return analysisRecord(prior);
				}
				const source = src;
				if (source.revision !== v.expectedRevision)
					throw new Error("revision_conflict");
				const timestamp = src.frame(v.frameIndex);
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
					sourceDigest: src.digest,
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
				storage.insert(db, r, owner, v);
				const job = queue.enqueueInTransaction(db, {
					scope,
					kind: `${scope}.analysis`,
					dedupeKey: r.id,
					payload: { id: r.id },
					subjectRef: r.id,
					lane: "interactive",
					resourceKey: "vision.perception",
					concurrencyKey: "vision.perception",
					availableAtMs: now,
					deadlineAtMs: now + ANALYSIS_BUDGET_MS,
					maxAttempts: 1,
				});
				storage.setJob(db, r.id, job.job.id);
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
				const src = storage.source(db, owner, sourceId);
				if (src.conversationId !== conversationId)
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
				return storage.source(db, owner, sourceId).bytes;
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

/** Application composition supplies the existing queue and LARM port to an owner storage adapter. */
export function createAnalysisFactory(
	store: SqliteStore,
	queue: QueueService,
	visual: () => PerceptionPort,
): MediaAnalysisFactory<AnalysisRecord, AnalysisCreate> {
	return (storage) => createMediaAnalyses({ store, queue, visual, storage });
}
