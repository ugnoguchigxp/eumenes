import { z } from "zod";
export const attributionSchema = z.strictObject({
	namespace: z.string().min(1).max(160),
	sourceId: z.string().min(1).max(160),
	displayName: z.string().min(1).max(120),
});
