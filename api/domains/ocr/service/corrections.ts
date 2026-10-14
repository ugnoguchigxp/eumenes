import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { Capabilities } from "../../capabilities";
import type { InferencePort } from "../../inference";
import type { QueueService } from "../../queue";
import {
	correctionCreate,
	correctionPlainText,
	correctionRecord,
	type CorrectionRecord,
} from "../contracts";
import { owned, record } from "../repository";
import {
	digest,
	correctionRow,
	parsed,
	update,
	sourceFrame,
} from "./correction-shared";
import { correctionHandler } from "./correction-handler";

const packageRevision = "package:ocr.correct@1";
const limit = 20;
export function createOcrCorrections(deps: {
	store: SqliteStore;
	queue: QueueService;
	inference: InferencePort;
	capabilities: () => Capabilities | null;
}) {
	const { store, queue, inference } = deps;
	const capabilities = () => {
		const c = deps.capabilities();
		if (!c) throw new Error("ocr_correction_unavailable");
		return c;
	};
	const own = (db: Database, id: string, owner: string) => {
		const r = correctionRow(db, id);
		if (!r || r.owner !== owner) throw new Error("ocr_correction_not_found");
		return r;
	};
	queue.registerHandler(correctionHandler(inference, capabilities));
	return {
		create(
			owner: string,
			sourceId: string,
			input: z.infer<typeof correctionCreate>,
		) {
			const value = correctionCreate.parse(input);
			return store.write((db) => {
				const existing = correctionRow(db, value.requestId);
				if (existing) {
					if (existing.owner !== owner) throw new Error("ocr_not_found");
					if (
						existing.source_id !== sourceId ||
						existing.conversation_id !== value.conversationId ||
						existing.source_revision !== value.expectedRevision ||
						existing.frame_key !== (value.frameIndex ?? -1)
					)
						throw new Error("request_conflict");
					return parsed(existing);
				}
				const src = owned(db, sourceId, owner);
				if (src.conversation_id !== value.conversationId)
					throw new Error("ocr_not_found");
				const v = record(src);
				if (v.state !== "completed" || !v.result)
					throw new Error("ocr_not_ready");
				if (v.revision !== value.expectedRevision)
					throw new Error("revision_conflict");
				const frame = sourceFrame(v.result, value.frameIndex);
				if (frame.text.length > 12000 || frame.lines.length > 200)
					throw new Error("ocr_correction_text_too_large");
				const count = db
					.query(
						"SELECT count(*) n FROM ocr_corrections WHERE source_id=? AND frame_key=?",
					)
					.get(sourceId, frame.key) as { n: number };
				if (count.n >= 50) throw new Error("ocr_correction_capacity");
				const prepared = capabilities().prepareActiveByIdInTransaction(
					db,
					{
						rootRunId: value.requestId,
						taskId: value.requestId,
						cancelEpoch: 0,
					},
					packageRevision,
					{
						sourceId,
						expectedRevision: value.expectedRevision,
						frameIndex: value.frameIndex,
					},
				);
				const now = Date.now();
				const candidate: CorrectionRecord = {
					id: value.requestId,
					sourceId,
					frameIndex: value.frameIndex ?? null,
					sourceRevision: v.revision,
					sourceDigest: digest(v.result),
					state: "queued",
					errorCode: null,
					result: null,
					createdAt: now,
					updatedAt: now,
				};
				db.query(
					"INSERT INTO ocr_corrections(id,source_id,owner,conversation_id,frame_key,source_revision,source_digest,record_json,bindings_json) VALUES(?,?,?,?,?,?,?,?,?)",
				).run(
					candidate.id,
					sourceId,
					owner,
					value.conversationId,
					frame.key,
					v.revision,
					candidate.sourceDigest,
					JSON.stringify(candidate),
					JSON.stringify(prepared),
				);
				const job = queue.enqueueInTransaction(db, {
					scope: "ocr",
					kind: "ocr.correct",
					dedupeKey: candidate.id,
					payload: { id: candidate.id },
					subjectRef: candidate.id,
					lane: "interactive",
					resourceKey: "inference.llm",
					concurrencyKey: `ocr-correct:${sourceId}:${frame.key}`,
					availableAtMs: now,
					deadlineAtMs: now + 120_000,
					maxAttempts: 1,
				});
				db.query("UPDATE ocr_corrections SET job_id=? WHERE id=?").run(
					job.job.id,
					candidate.id,
				);
				return candidate;
			});
		},
		get(owner: string, id: string, sourceId?: string) {
			return store.read((db) => {
				const r = own(db, id, owner);
				if (sourceId && r.source_id !== sourceId)
					throw new Error("ocr_correction_not_found");
				return parsed(r);
			});
		},
		list(
			owner: string,
			sourceId: string,
			frameIndex?: number,
			before?: number,
		) {
			return store.read((db) => {
				owned(db, sourceId, owner);
				const key = frameIndex ?? -1;
				const rows = db
					.query(
						"SELECT rowid cursor,record_json FROM ocr_corrections WHERE source_id=? AND owner=? AND frame_key=? AND rowid<? ORDER BY rowid DESC LIMIT ?",
					)
					.all(
						sourceId,
						owner,
						key,
						before ?? Number.MAX_SAFE_INTEGER,
						limit + 1,
					) as { cursor: number; record_json: string }[];
				const pref = db
					.query(
						"SELECT preferred_id,revision FROM ocr_correction_preference WHERE source_id=? AND frame_key=?",
					)
					.get(sourceId, key) as {
					preferred_id: string | null;
					revision: number;
				} | null;
				const items = rows
					.slice(0, limit)
					.map((r) => correctionRecord.parse(JSON.parse(r.record_json)));
				if (
					before === undefined &&
					pref?.preferred_id &&
					!items.some((r) => r.id === pref.preferred_id)
				) {
					const preferred = correctionRow(db, pref.preferred_id);
					if (
						preferred &&
						preferred.source_id === sourceId &&
						preferred.frame_key === key &&
						preferred.owner === owner
					)
						items.push(parsed(preferred));
				}
				return {
					items,
					nextCursor: rows.length > limit ? rows[limit - 1]!.cursor : null,
					preference: {
						preferredId: pref?.preferred_id ?? null,
						revision: pref?.revision ?? 0,
					},
				};
			});
		},
		async cancel(owner: string, id: string, sourceId?: string) {
			const refs = await store.write((db) => {
				const r = own(db, id, owner);
				if (sourceId && r.source_id !== sourceId)
					throw new Error("ocr_correction_not_found");
				if (!["queued", "running", "cancelling"].includes(parsed(r).state))
					return null;
				update(db, r, { state: "cancelling" });
				if (r.inference_request_id)
					inference.cancelRequestsInTransaction?.(db, [r.inference_request_id]);
				const job = r.job_id
					? queue.cancelInTransaction(db, r.job_id, "cancel_requested")
					: null;
				if (
					!job ||
					!["queued", "running", "retry_wait", "cancel_requested"].includes(
						job.job.state,
					)
				) {
					const current = correctionRow(db, id);
					if (current && parsed(current).state === "cancelling")
						update(db, current, { state: "cancelled", errorCode: null });
				}
				return { jobId: r.job_id, inferenceId: r.inference_request_id };
			});
			if (refs?.jobId) queue.flushCancellations([refs.jobId]);
			if (refs?.inferenceId)
				inference.flushCancelledRequests?.([refs.inferenceId]);
			return this.get(owner, id, sourceId);
		},
		prefer(
			owner: string,
			sourceId: string,
			frameIndex: number | undefined,
			preferredId: string | null,
			expectedRevision: number,
		) {
			return store.write((db) => {
				const src = owned(db, sourceId, owner);
				const v = record(src);
				if (v.state !== "completed" || !v.result)
					throw new Error("ocr_not_ready");
				const frame = sourceFrame(v.result, frameIndex);
				const current = db
					.query(
						"SELECT preferred_id,revision FROM ocr_correction_preference WHERE source_id=? AND frame_key=?",
					)
					.get(sourceId, frame.key) as {
					preferred_id: string | null;
					revision: number;
				} | null;
				if ((current?.revision ?? 0) !== expectedRevision)
					throw new Error("revision_conflict");
				if (preferredId) {
					const r = own(db, preferredId, owner);
					const c = parsed(r);
					if (
						r.source_id !== sourceId ||
						r.frame_key !== frame.key ||
						c.state !== "completed" ||
						c.sourceRevision !== v.revision ||
						c.sourceDigest !== digest(v.result)
					)
						throw new Error("ocr_correction_not_ready");
				}
				db.query(
					"INSERT INTO ocr_correction_preference(source_id,frame_key,preferred_id,revision) VALUES(?,?,?,1) ON CONFLICT(source_id,frame_key) DO UPDATE SET preferred_id=excluded.preferred_id,revision=revision+1",
				).run(sourceId, frame.key, preferredId);
				return { preferredId, revision: expectedRevision + 1 };
			});
		},
		conversationText(owner: string, id: string, sourceId?: string) {
			return store.read((db) => {
				const r = own(db, id, owner);
				if (sourceId && r.source_id !== sourceId)
					throw new Error("ocr_correction_not_found");
				const c = parsed(r);
				const src = owned(db, r.source_id, owner);
				const v = record(src);
				if (
					c.state !== "completed" ||
					!c.result ||
					v.revision !== c.sourceRevision ||
					digest(v.result) !== c.sourceDigest
				)
					throw new Error("ocr_correction_not_ready");
				const text = `LLM補正案（資料ID: ${r.source_id}、候補ID: ${id}${c.frameIndex === null ? "" : `、フレーム: ${c.frameIndex}`}）\n${correctionPlainText(c.result)}\n判読困難箇所: ${c.result.blocks.flatMap((b) => (b.kind === "paragraph" ? (b.uncertain ? [b.uncertainty ?? ""] : []) : b.cells.filter((c) => c.uncertain).map((c) => c.uncertainty ?? ""))).join("; ")}`;
				if (text.length > 8000) throw new Error("ocr_text_too_large");
				return { text, conversationId: r.conversation_id };
			});
		},
		removeInTransaction(db: Database, sourceId: string) {
			const rows = db
				.query(
					"SELECT job_id,inference_request_id FROM ocr_corrections WHERE source_id=?",
				)
				.all(sourceId) as {
				job_id: string | null;
				inference_request_id: string | null;
			}[];
			for (const r of rows) {
				if (r.job_id) queue.cancelInTransaction(db, r.job_id, "source_removed");
				if (r.inference_request_id)
					inference.cancelRequestsInTransaction?.(db, [r.inference_request_id]);
			}
			db.query("DELETE FROM ocr_corrections WHERE source_id=?").run(sourceId);
			db.query("DELETE FROM ocr_correction_preference WHERE source_id=?").run(
				sourceId,
			);
			return rows.filter((r) => r.job_id).map((r) => r.job_id!);
		},
	};
}
