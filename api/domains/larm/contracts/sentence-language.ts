import { z } from "zod";

export const sentenceLanguageSchema = z.enum(["ja", "en"]);
export type SentenceLanguage = z.infer<typeof sentenceLanguageSchema>;
/** Normalized choice result; model identity is supplied by the claimed provider. */
export const sentenceLanguageDecisionSchema = z
	.object({
		language: sentenceLanguageSchema,
		model: z.string().min(1).max(200),
		latencyMs: z.number().finite().nonnegative(),
	})
	.strict();
export type SentenceLanguageDecision = z.infer<
	typeof sentenceLanguageDecisionSchema
>;
