import { z } from "zod";
export const recognitionManage = z.strictObject({
	action: z.enum(["open", "read", "cancel"]),
	id: z.string().max(200),
	frameIndex: z.number().int().min(-1).max(59),
});
export const recognitionCommand = recognitionManage.extend({
	operation: z.literal("manage"),
});
