import type { Hono } from "hono";
import { z } from "zod";
import { limitConcurrency } from "../../infrastructure/concurrency";
import { parseJsonBody } from "../../infrastructure/http";
import type { ConversationService } from "../../domains/conversation";
import type { ImageService } from "../../domains/image";
import { imageArtifactId } from "../../domains/larm/contracts";
import { attachmentFile } from "./attachment-file";

const libraryAttachmentInput = z.strictObject({
	requestId: z.uuid(),
	imageId: imageArtifactId,
});

/**
 * A saved library image becomes a pending chat attachment, converted by the same rule as other
 * host-made attachments. The request id is the attachment id, so a resend returns the same one.
 */
export function registerLibraryAttachment(
	app: Hono,
	image: Pick<ImageService, "content">,
	conversation: Pick<ConversationService, "uploadAttachment">,
) {
	app.post(
		"/api/conversations/:id/attachments/library",
		limitConcurrency(2, "attachment_capacity"),
		async (c) => {
			const conversationId = c.req.param("id");
			if (!conversationId || conversationId.length > 120)
				return c.json({ error: "invalid_attachment_input" }, 400);
			const input = await parseJsonBody(c, libraryAttachmentInput, {
				code: "invalid_attachment_input",
			});
			if (!input.ok) return input.response;
			const { requestId, imageId } = input.data;
			let content: Awaited<ReturnType<ImageService["content"]>>;
			try {
				content = await image.content(
					imageId,
					AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30000)]),
				);
			} catch {
				return c.json({ error: "image_content_unavailable" }, 502);
			}
			if (!content.bytes || !content.mime)
				return c.json({ error: "image_content_unavailable" }, 502);
			let file: File;
			try {
				({ file } = await attachmentFile({
					bytes: content.bytes,
					mime: content.mime,
					name: `image-${imageId}.${content.mime === "image/png" ? "png" : "webp"}`,
				}));
			} catch {
				// An image sharp cannot decode is as unusable as one LARM could not return.
				return c.json({ error: "image_content_unavailable" }, 502);
			}
			return c.json(
				await conversation.uploadAttachment(conversationId, requestId, file),
				201,
			);
		},
	);
}
