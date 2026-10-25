import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { QueueService } from "../../queue";
import { qrCreate, type QrRecord } from "../contracts/qr";
import { owned, record, row } from "../repository";
import {
	latestQr,
	parsedQr,
	qrRow,
	updateQr,
	type QrRow,
} from "../repository/qr";
import { digest, sourceFrame } from "./correction-shared";
import { qrDecoderVersion } from "./qr-input";
import { qrHandler } from "./qr-handler";
import type { decodeQr } from "./qr-input";
import type { z } from "zod";

export function createOcrQr(
	store: SqliteStore,
	queue: QueueService,
	decode?: typeof decodeQr,
) {
	queue.registerHandler(qrHandler(decode));
	function own(db: Database, owner: string, sourceId: string, id: string) {
		const src = owned(db, sourceId, owner);
		const r = qrRow(db, id);
		if (!r || r.owner !== owner || r.source_id !== src.id)
			throw new Error("ocr_qr_not_found");
		return r;
	}
	function createInTransaction(
		db: Database,
		owner: string,
		sourceId: string,
		input: z.infer<typeof qrCreate>,
	) {
		const value = qrCreate.parse(input);
		const prior = qrRow(db, value.requestId);
		if (prior) {
			if (prior.owner !== owner) throw new Error("ocr_qr_not_found");
			if (
				prior.source_id !== sourceId ||
				prior.conversation_id !== value.conversationId ||
				prior.frame_key !== (value.frameIndex ?? -1) ||
				prior.source_revision !== value.expectedRevision
			)
				throw new Error("request_conflict");
			return parsedQr(prior);
		}
		const src = owned(db, sourceId, owner);
		const v = record(src);
		if (src.conversation_id !== value.conversationId)
			throw new Error("ocr_not_found");
		if (v.state !== "completed" || !v.result) throw new Error("ocr_not_ready");
		if (v.revision !== value.expectedRevision)
			throw new Error("revision_conflict");
		const frame = sourceFrame(v.result, value.frameIndex);
		const latest = latestQr(db, sourceId, frame.key, v.revision);
		if (
			latest &&
			["queued", "running", "cancelling", "completed"].includes(
				parsedQr(latest).state,
			)
		)
			throw new Error("ocr_qr_busy");
		const now = Date.now();
		const c: QrRecord = {
			id: value.requestId,
			sourceId,
			frameIndex: value.frameIndex ?? null,
			sourceRevision: v.revision,
			sourceDigest: digest(v.result),
			decoderVersion: qrDecoderVersion,
			state: "queued",
			errorCode: null,
			items: null,
			createdAt: now,
			updatedAt: now,
		};
		db.query(
			"INSERT INTO ocr_qr(id,source_id,owner,conversation_id,frame_key,source_revision,record_json) VALUES(?,?,?,?,?,?,?)",
		).run(
			c.id,
			sourceId,
			owner,
			value.conversationId,
			frame.key,
			v.revision,
			JSON.stringify(c),
		);
		const job = queue.enqueueInTransaction(db, {
			scope: "ocr",
			kind: "ocr.qr",
			dedupeKey: c.id,
			payload: { id: c.id },
			subjectRef: c.id,
			lane: "interactive",
			resourceKey: "ocr.qr",
			concurrencyKey: `ocr-qr:${sourceId}:${frame.key}`,
			availableAtMs: now,
			deadlineAtMs: now + 30_000,
			maxAttempts: 1,
		});
		db.query("UPDATE ocr_qr SET job_id=? WHERE id=?").run(job.job.id, c.id);
		return c;
	}
	const cancelRow = (db: Database, r: QrRow) => {
		if (!["queued", "running", "cancelling"].includes(parsedQr(r).state))
			return null;
		updateQr(db, r, { state: "cancelling" });
		const job = r.job_id
			? queue.cancelInTransaction(db, r.job_id, "cancel_requested")
			: null;
		if (
			!job ||
			!["queued", "running", "cancel_requested"].includes(job.job.state)
		)
			updateQr(db, qrRow(db, r.id)!, { state: "cancelled", items: null });
		return r.job_id;
	};
	return {
		create: (
			owner: string,
			sourceId: string,
			input: z.infer<typeof qrCreate>,
		) => store.write((db) => createInTransaction(db, owner, sourceId, input)),
		autoInTransaction(db: Database, sourceId: string) {
			const src = row(db, sourceId);
			if (!src) return;
			const v = record(src);
			if (
				v.state !== "completed" ||
				v.result?.kind !== "image" ||
				latestQr(db, sourceId, -1, v.revision)
			)
				return;
			createInTransaction(db, src.owner, sourceId, {
				requestId: crypto.randomUUID(),
				conversationId: src.conversation_id,
				expectedRevision: v.revision,
			});
		},
		latest(owner: string, sourceId: string, frameIndex?: number) {
			return store.read((db) => {
				const src = owned(db, sourceId, owner);
				const v = record(src);
				if (!v.result || v.state !== "completed") return null;
				const frame = sourceFrame(v.result, frameIndex);
				const r = latestQr(db, sourceId, frame.key, v.revision);
				return r ? parsedQr(r) : null;
			});
		},
		get: (owner: string, sourceId: string, id: string) =>
			store.read((db) => parsedQr(own(db, owner, sourceId, id))),
		async cancel(owner: string, sourceId: string, id: string) {
			const job = await store.write((db) =>
				cancelRow(db, own(db, owner, sourceId, id)),
			);
			if (job) queue.flushCancellations([job]);
			return this.get(owner, sourceId, id);
		},
		conversationText(
			owner: string,
			sourceId: string,
			id: string,
			index: number,
		) {
			return store.read((db) => {
				const r = own(db, owner, sourceId, id);
				const c = parsedQr(r);
				const src = owned(db, sourceId, owner);
				const v = record(src);
				if (
					c.state !== "completed" ||
					!v.result ||
					v.state !== "completed" ||
					v.revision !== c.sourceRevision ||
					digest(v.result) !== c.sourceDigest
				)
					throw new Error("ocr_qr_not_ready");
				const item = c.items?.[index];
				if (!item || item.text === null) throw new Error("ocr_qr_not_ready");
				const time = sourceFrame(v.result, c.frameIndex ?? undefined).timestamp;
				const text = `QRコードの復号結果（資料ID: ${sourceId}、結果ID: ${id}、位置番号: ${index + 1}${time === null ? "" : `、フレーム時刻: ${time}秒`}）\n${item.text}`;
				if (text.length > 8000) throw new Error("ocr_text_too_large");
				return { text, conversationId: r.conversation_id };
			});
		},
		removeInTransaction(db: Database, sourceId: string) {
			const rows = db
				.query("SELECT * FROM ocr_qr WHERE source_id=?")
				.all(sourceId) as QrRow[];
			for (const r of rows) cancelRow(db, r);
			db.query("DELETE FROM ocr_qr WHERE source_id=?").run(sourceId);
			return rows.flatMap((r) => (r.job_id ? [r.job_id] : []));
		},
	};
}
