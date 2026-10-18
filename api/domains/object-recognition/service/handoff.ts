import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { RecognitionRecord } from "../contracts";
import {
	owned,
	ownedHandoff,
	pendingHandoffs,
	record,
	updateHandoff,
	type Row,
} from "../repository";

/** What the host hands to the conversation: the stored still and its detections as reference data. */
export type ImageMaterial = {
	conversationId: string;
	name: string;
	bytes: Uint8Array;
	mime: string;
	meta: Record<string, unknown>;
};

/** A finished still only. A failed or withdrawn detection still shows the image, with empty meta. */
export function imageMaterial(r: Row): ImageMaterial {
	const v = record(r);
	if (!r.mime.startsWith("image/"))
		throw new Error("recognition_image_required");
	if (!["completed", "failed", "cancelled"].includes(v.state))
		throw new Error("recognition_not_ready");
	return {
		conversationId: r.conversation_id,
		name: v.name,
		bytes: r.bytes,
		mime: r.mime,
		meta: v.state === "completed" ? meta(v) : {},
	};
}

/** The highest-scoring detections kept in the meta, so it stays inside the attachment's annotation limit. */
const metaObjects = 100;
function meta(v: RecognitionRecord): Record<string, unknown> {
	const r = v.result;
	if (r?.kind !== "image") return {};
	const kept = [...r.objects]
		.sort((a, b) => b.confidence - a.confidence)
		.slice(0, metaObjects);
	return {
		source: "object-recognition",
		recognitionId: v.id,
		captureSource: v.origin ?? "file",
		capturedAt: new Date(v.createdAt).toISOString(),
		image: { width: r.width, height: r.height },
		detector: { model: r.model, vocabulary: "80 COCO classes" },
		objects: kept.map((o) => ({
			label: o.label,
			box: o.box.map((n) => Math.round(n)),
			score: Math.round(o.confidence * 1000) / 1000,
		})),
		notes: [
			"box is [x1, y1, x2, y2] in source pixels",
			"score is not a calibrated probability",
			"objects outside the vocabulary are not detected",
			...(r.objects.length > kept.length
				? [
						`only the ${kept.length} highest-scoring of ${r.objects.length} detections are listed`,
					]
				: []),
		],
	};
}

/** The first still saved for an open camera/screen request answers it; a later one stays a plain record. */
export function bindCapture(
	db: Database,
	owner: string,
	handoffId: string,
	conversationId: string,
	recognitionId: string,
) {
	const h = ownedHandoff(db, handoffId, owner);
	if (
		h.state === "pending" &&
		h.source !== "saved" &&
		!h.recognitionId &&
		h.conversationId === conversationId
	)
		updateHandoff(db, handoffId, { state: "pending", recognitionId });
}

export function createHandoffs(store: SqliteStore) {
	function linked(
		db: Database,
		owner: string,
		id: string,
		recognitionId?: string,
	) {
		const h = ownedHandoff(db, id, owner);
		if (h.state === "cancelled" || h.state === "expired")
			throw new Error("recognition_handoff_closed");
		// The record the host bound (or a saved request names) wins; another still is a conflict.
		const target = h.recognitionId ?? recognitionId;
		if (
			!target ||
			(recognitionId && h.recognitionId && recognitionId !== h.recognitionId)
		)
			throw new Error("request_conflict");
		const r = owned(db, target, owner);
		if (r.conversation_id !== h.conversationId)
			throw new Error("recognition_not_found");
		const material = imageMaterial(r);
		if (h.state === "pending" && !h.recognitionId)
			updateHandoff(db, id, { state: "pending", recognitionId: target });
		return { material, question: h.question };
	}
	return {
		attachmentMaterial: (owner: string, id: string) =>
			store.read((db) => imageMaterial(owned(db, id, owner))),
		handoffs: (owner: string, conversationId: string) =>
			store.read((db) => pendingHandoffs(db, owner, conversationId)),
		cancelHandoff: (owner: string, id: string) =>
			store.write((db) => {
				const h = ownedHandoff(db, id, owner);
				if (h.state === "pending")
					updateHandoff(db, id, { state: "cancelled" });
				return ownedHandoff(db, id, owner);
			}),
		/** Binds the taken still once; a repeated send of a sent handoff returns the same material. */
		handoffMaterial: (owner: string, id: string, recognitionId?: string) =>
			store.write((db) => linked(db, owner, id, recognitionId)),
		assertHandoffOpen: (owner: string, id: string) =>
			store.read((db) => {
				const h = ownedHandoff(db, id, owner);
				if (h.state === "cancelled" || h.state === "expired")
					throw new Error("recognition_handoff_closed");
			}),
		completeHandoff: (owner: string, id: string) =>
			store.write((db) => {
				if (ownedHandoff(db, id, owner).state === "pending")
					updateHandoff(db, id, { state: "sent" });
			}),
	};
}
