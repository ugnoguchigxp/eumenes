import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { attachmentLimits, type Attachment } from "../contracts/attachments";
import { ownedAttachment, messageAttachments } from "../repository/attachments";
import { normalizeImage } from "./normalize-image";
const digest = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

export function createAttachments(store: SqliteStore, principal: string) {
	return {
		async uploadAttachment(
			conversationId: string,
			id: string,
			file: File,
			annotation?: Attachment["annotation"],
		): Promise<Attachment> {
			if (file.size > attachmentLimits.maxBytes)
				throw new Error("image_too_large");
			if (
				annotation &&
				Buffer.byteLength(JSON.stringify(annotation)) >
					attachmentLimits.annotationBytes
			)
				throw new Error("attachment_annotation_too_large");
			const original = new Uint8Array(await file.arrayBuffer());
			const originalDigest = digest(original);
			const normalized = await normalizeImage(original, file.type);
			return store.write((db) => {
				const existing = db
					.query("SELECT id FROM conversation_attachments WHERE id=?")
					.get(id);
				if (existing) {
					const row = ownedAttachment(db, id, principal, conversationId);
					if (row.original_digest !== originalDigest)
						throw new Error("request_conflict");
					return JSON.parse(row.metadata);
				}
				db.query(
					"DELETE FROM conversation_attachments WHERE expires_at<? AND id NOT IN(SELECT attachment_id FROM message_attachments)",
				).run(Date.now());
				const pending = db
					.query(
						"SELECT COALESCE(SUM(length(original)+length(bytes)+length(preview)),0) AS size FROM conversation_attachments WHERE principal=? AND id NOT IN(SELECT attachment_id FROM message_attachments)",
					)
					.get(principal) as { size: number };
				if (
					pending.size +
						original.length +
						normalized.bytes.length +
						normalized.preview.length >
					attachmentLimits.pendingBytes
				)
					throw new Error("attachment_capacity");
				const meta: Attachment = {
					id,
					conversationId,
					name: file.name.slice(0, 200),
					mime: normalized.mime,
					originalMime: normalized.originalMime,
					width: normalized.width,
					height: normalized.height,
					size: normalized.bytes.length,
					digest: digest(normalized.bytes),
					createdAt: new Date().toISOString(),
					...(annotation ? { annotation } : {}),
				};
				db.query(
					"INSERT INTO conversation_attachments VALUES(?,?,?,?,?,?,?,?,?)",
				).run(
					id,
					principal,
					conversationId,
					JSON.stringify(meta),
					original,
					normalized.bytes,
					normalized.preview,
					originalDigest,
					Date.now() + attachmentLimits.pendingHours * 3600000,
				);
				return meta;
			});
		},
		attachmentsByIdsInTransaction(
			db: Database,
			conversationId: string,
			ids: string[],
		): Attachment[] {
			return ids.map((id) =>
				JSON.parse(ownedAttachment(db, id, principal, conversationId).metadata),
			);
		},
		attachmentContent(conversationId: string, id: string, preview = false) {
			return store.read((db) => {
				const r = ownedAttachment(db, id, principal, conversationId);
				return {
					bytes: preview ? r.preview : r.bytes,
					mime: preview
						? "image/png"
						: (JSON.parse(r.metadata) as Attachment).mime,
				};
			});
		},
		resolveAttachmentsInTransaction(
			db: Database,
			conversationId: string,
			refs: Attachment[],
		) {
			return refs.map((ref) => {
				const r = ownedAttachment(db, ref.id, principal, conversationId);
				if (digest(r.bytes) !== ref.digest)
					throw new Error("attachment_source_unavailable");
				return {
					bytes: r.bytes,
					mime: ref.mime,
					width: ref.width,
					height: ref.height,
				};
			});
		},
		validAttachmentSourcesInTransaction(
			db: Database,
			conversationId: string,
			refs: Attachment[],
		) {
			try {
				for (const ref of refs) {
					const r = ownedAttachment(db, ref.id, principal, conversationId);
					if (digest(r.bytes) !== ref.digest) return false;
				}
				return true;
			} catch {
				return false;
			}
		},
		validateAttachmentsInTransaction(
			db: Database,
			messageId: string,
			refs: Attachment[],
		) {
			const live = db
				.query("SELECT id FROM messages WHERE id=? AND retracted_at IS NULL")
				.get(messageId);
			if (!live) return false;
			return (
				JSON.stringify(messageAttachments(db, messageId)) ===
				JSON.stringify(refs)
			);
		},
	};
}
