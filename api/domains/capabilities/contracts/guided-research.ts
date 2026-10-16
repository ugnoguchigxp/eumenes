import { z } from "zod";

/** Versioned Web worker input; no parent conversation or provider settings. */
export const guidedResearchInput = z
	.object({
		question: z.string().min(1).max(8000),
		urls: z.array(z.string().url().max(2048)).max(3).optional(),
		detail: z.enum(["brief", "normal"]).default("normal"),
	})
	.strict();
