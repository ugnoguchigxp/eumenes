import { createHash } from "node:crypto";
import sharp, { type OutputInfo } from "sharp";
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

/**
 * WebP or over-limit stills become a JPEG the attachment rules accept; others pass unchanged.
 * `scaled` is the attached size when it differs from the source the boxes are measured in.
 */
async function attachmentFile(
	m: ImageMaterial,
): Promise<{ file: File; scaled?: { width: number; height: number } }> {
	const meta = await sharp(m.bytes).metadata();
	const pixels = (meta.width ?? 0) * (meta.height ?? 0);
	if (
		(m.mime === "image/jpeg" || m.mime === "image/png") &&
		m.bytes.length <= attachmentLimits.maxBytes &&
		pixels <= attachmentLimits.maxPixels &&
		Math.max(meta.width ?? 0, meta.height ?? 0) <= attachmentLimits.maxDimension
	)
		return {
			file: new File([new Uint8Array(m.bytes)], m.name, { type: m.mime }),
		};
	let out: { data: Buffer; info: OutputInfo } | undefined;
	for (const edge of [4096, 2560, 1600]) {
		out = await sharp(m.bytes)
			.rotate()
			.resize({
				width: edge,
				height: edge,
				fit: "inside",
				withoutEnlargement: true,
			})
			.flatten({ background: "#ffffff" })
			.jpeg({ quality: 88 })
			.toBuffer({ resolveWithObject: true });
		if (out.data.length <= attachmentLimits.maxBytes) break;
	}
	const file = new File(
		[new Uint8Array(out!.data)],
		m.name.replace(/\.\w+$/, "") + ".jpg",
		{ type: "image/jpeg" },
	);
	return out!.info.width === meta.width && out!.info.height === meta.height
		? { file }
		: { file, scaled: { width: out!.info.width, height: out!.info.height } };
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
