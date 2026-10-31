import { z } from "zod";
/** Revision 2 adds capture (camera/screen after the user agreed) and ask (a saved image on screen). */
export const recognitionManageV2 = z.strictObject({
	action: z.enum(["open", "read", "cancel", "capture", "ask"]),
	id: z.string().max(200),
	frameIndex: z.number().int().min(-1).max(59),
	source: z.enum(["camera", "screen"]),
	question: z.string().max(500),
});
/** Commands of both revisions; revision 1 has no source or question. */
export const recognitionCommand = recognitionManageV2
	.extend({
		source: recognitionManageV2.shape.source.optional(),
		question: recognitionManageV2.shape.question.optional(),
	})
	.extend({ operation: z.literal("manage") });
