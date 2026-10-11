import { parseLlmJson } from "../../../infrastructure/llm-json";
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
const endpointFields = {
	relation: z.enum(["continuation", "independent", "uncertain"]),
	readiness: z.enum(["ready", "waiting", "uncertain"]),
	relationConfidence: z.number().min(0).max(1),
	readinessConfidence: z.number().min(0).max(1),
};
export const transcriptAssessmentResult = z.discriminatedUnion("status", [
	transcriptLanguageResult.options[0].extend(endpointFields),
	transcriptLanguageResult.options[1].extend(endpointFields),
]);
export type TranscriptContext = {
	previousText: string;
	conversation: Array<{ role: string; text: string }>;
};
const assessmentPolicy = readFileSync(
	new URL("../prompts/transcript-assessment.md", import.meta.url),
	"utf8",
);
export function parseTranscriptAssessment(value: unknown) {
	if (typeof value !== "string" || Buffer.byteLength(value) > 4096)
		throw new Error("asr_language_unverified");
	try {
		return transcriptAssessmentResult.parse(parseLlmJson(value, 4096));
	} catch {
		throw new Error("asr_language_unverified");
	}
}
const policy = readFileSync(
	new URL("../prompts/transcript-language.md", import.meta.url),
	"utf8",
);
export function transcriptLanguageMessages(
	text: string,
	context?: TranscriptContext,
) {
	return [
		{
			role: "system" as const,
			content:
				policy +
				(context ? "\n" + assessmentPolicy : "") +
				"\nOUTPUT_SCHEMA=" +
				JSON.stringify(
					z.toJSONSchema(
						context ? transcriptAssessmentResult : transcriptLanguageResult,
					),
				),
		},
		{
			role: "user" as const,
			content: JSON.stringify({ languageCodes: codes, text, ...context }),
		},
	];
}
export function parseTranscriptLanguage(
	value: unknown,
): TranscriptLanguageResult {
	if (typeof value !== "string" || Buffer.byteLength(value) > 4096)
		throw new Error("asr_language_unverified");
	try {
		return transcriptLanguageResult.parse(parseLlmJson(value, 4096));
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
