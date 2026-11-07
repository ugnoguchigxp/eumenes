import { z } from "zod";
import { chatInputSchema } from "../../larm/contracts";

const imageRoute = z.object({
	source: z.enum([
		"larm",
		"codex-sdk",
		"claude-agent-sdk",
		"openai-compatible",
		"cloudflare-workers-ai",
	]),
	status: z.enum(["supported", "unsupported", "unknown", "failed"]),
	/** LARM's authoritative claim contract; never presented as cloud retention. */
	chatInput: chatInputSchema.optional(),
});
export const imageInputSchema = z.object({
	revision: z.number().int().nonnegative(),
	primary: imageRoute,
	fallback: imageRoute.optional(),
});
export type ImageInputStatus = z.infer<typeof imageInputSchema>;
