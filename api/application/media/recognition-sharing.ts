import { createHash } from "node:crypto";
import sharp from "sharp";
import type {
	ImageMaterial,
	RecognitionSharing,
} from "../../domains/object-recognition";
import type { ConversationService } from "../../domains/conversation";
import { attachmentLimits } from "../../domains/conversation/contracts";
import type { Submit } from "../../domains/dialogue/contracts";

/** A stable RFC 9562 version-8 id per (seed, purpose), so a resend reuses the same attachment and run. */
export function derivedId(seed: string, purpose: string) {
	const h = createHash("sha256").update(`${purpose}:${seed}`).digest();
	h[6] = (h[6]! & 0x0f) | 0x80;
	h[8] = (h[8]! & 0x3f) | 0x80;
	const x = h.subarray(0, 16).toString("hex");
	return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** WebP or over-limit stills become a JPEG the attachment rules accept; others pass unchanged. */
async function attachmentFile(m: ImageMaterial) {
	const meta = await sharp(m.bytes).metadata();
	const pixels = (meta.width ?? 0) * (meta.height ?? 0);
	if (
		(m.mime === "image/jpeg" || m.mime === "image/png") &&
		m.bytes.length <= attachmentLimits.maxBytes &&
		pixels <= attachmentLimits.maxPixels
	)
		return new File([new Uint8Array(m.bytes)], m.name, { type: m.mime });
	let bytes: Buffer | undefined;
	for (const edge of [4096, 2560, 1600]) {
		bytes = await sharp(m.bytes)
			.rotate()
			.resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
			.flatten({ background: "#ffffff" })
			.jpeg({ quality: 88 })
			.toBuffer();
		if (bytes.length <= attachmentLimits.maxBytes) break;
	}
	return new File([new Uint8Array(bytes!)], m.name.replace(/\.\w+$/, "") + ".jpg", {
		type: "image/jpeg",
	});
}

export function recognitionSharing(deps: {
	conversation: Pick<ConversationService, "uploadAttachment">;
	submit: (input: Submit) => Promise<unknown>;
}): RecognitionSharing {
	const upload = async (m: ImageMaterial, seed: string) =>
		deps.conversation.uploadAttachment(
			m.conversationId,
			derivedId(seed, "recognition-attachment"),
			await attachmentFile(m),
			{ source: "object-recognition", data: m.meta },
		);
	return {
		attach: (material, requestId) => upload(material, requestId),
		async send(material, question, handoffId) {
			const attachment = await upload(material, handoffId);
			return deps.submit({
				requestId: derivedId(handoffId, "recognition-run"),
				conversationId: material.conversationId,
				text: question.trim().slice(0, 500) || "撮影した画像です。",
				attachmentIds: [attachment.id],
			});
		},
	};
}
