import { z } from "zod";
import { readFileSync } from "node:fs";
import { asrLanguages, type AsrLanguage } from "../../settings/contracts";
const codes = [...asrLanguages.map(([code]) => code), "other"] as const;
export const transcriptLanguageResult = z.discriminatedUnion("status", [
	z
		.object({
			status: z.literal("identified"),
			languages: z
				.array(z.enum(codes))
				.min(1)
				.max(4)
				.refine((v) => new Set(v).size === v.length),
			confidence: z.number().min(0).max(1),
		})
		.strict(),
	z
		.object({
			status: z.literal("undetermined"),
			languages: z.array(z.enum(codes)).max(0),
			confidence: z.number().min(0).max(1),
		})
		.strict(),
]);
export type TranscriptLanguageResult = z.infer<typeof transcriptLanguageResult>;
const policy = readFileSync(
	new URL("../prompts/transcript-language.md", import.meta.url),
	"utf8",
);
export function transcriptLanguageMessages(text: string) {
	return [
		{
			role: "system" as const,
			content:
				policy +
				"\nOUTPUT_SCHEMA=" +
				JSON.stringify(z.toJSONSchema(transcriptLanguageResult)),
		},
		{
			role: "user" as const,
			content: JSON.stringify({ languageCodes: codes, text }),
		},
	];
}
export function parseTranscriptLanguage(
	value: unknown,
): TranscriptLanguageResult {
	if (typeof value !== "string" || Buffer.byteLength(value) > 4096)
		throw new Error("asr_language_unverified");
	try {
		return transcriptLanguageResult.parse(JSON.parse(value));
	} catch {
		throw new Error("asr_language_unverified");
	}
}
export function transcriptLanguageStatus(
	result: TranscriptLanguageResult,
	allowed: readonly AsrLanguage[],
): "allowed" | "not_allowed" | "unverified" {
	if (result.status === "undetermined" || result.confidence < 0.8)
		return "unverified";
	return result.languages.every((l) => l !== "other" && allowed.includes(l))
		? "allowed"
		: "not_allowed";
}
