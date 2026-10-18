import { z } from "zod";

export const screenPresenceSchema = z
	.object({
		revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
		active: z.boolean(),
		sentAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	})
	.strict();
