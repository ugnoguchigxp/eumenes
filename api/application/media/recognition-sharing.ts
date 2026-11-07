import { createHash } from "node:crypto";
import type {
	ImageMaterial,
	RecognitionSharing,
} from "../../domains/object-recognition";
import type { ConversationService } from "../../domains/conversation";
import type { Submit } from "../../domains/dialogue/contracts";
import { attachmentFile } from "./attachment-file";

/** A stable RFC 9562 version-8 id per (seed, purpose), so a resend reuses the same attachment and run. */
export function derivedId(seed: string, purpose: string) {
	const h = createHash("sha256").update(`${purpose}:${seed}`).digest();
	h[6] = (h[6]! & 0x0f) | 0x80;
	h[8] = (h[8]! & 0x3f) | 0x80;
	const x = h.subarray(0, 16).toString("hex");
	return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export function recognitionSharing(deps: {
	conversation: Pick<ConversationService, "uploadAttachment">;
	submit: (input: Submit) => Promise<unknown>;
}): RecognitionSharing {
	const upload = async (m: ImageMaterial, seed: string) => {
		const { file, scaled } = await attachmentFile(m);
		// Boxes stay in source pixels; a scaled attachment says its own size so they can be mapped.
		const data =
			scaled && Object.keys(m.meta).length
				? { ...m.meta, attachedImage: scaled }
				: m.meta;
		return deps.conversation.uploadAttachment(
			m.conversationId,
			derivedId(seed, "recognition-attachment"),
			file,
			{ source: "object-recognition", data },
		);
	};
	return {
		attach: (material, requestId) => upload(material, requestId),
		async send(material, question, handoffId, ensureOpen) {
			const attachment = await upload(material, handoffId);
			ensureOpen();
			return deps.submit({
				requestId: derivedId(handoffId, "recognition-run"),
				conversationId: material.conversationId,
				text: question.trim().slice(0, 500) || "撮影した画像です。",
				attachmentIds: [attachment.id],
			});
		},
	};
}
