import { systemContext } from "../../../infrastructure/system-context";
import { z } from "zod";
import { parseLlmJson } from "../../../infrastructure/llm-json";
import { asrLanguages, type AsrLanguage } from "../../settings/contracts";

const codes = [...asrLanguages.map(([code]) => code), "other"] as const;
const result = z.object({ languages: z.array(z.enum(codes)).max(4) }).strict();
const policy =
	systemContext("voice-dialogue.contexts.transcript-language.policy", {}) +
	"\n";

/** Kana is written only in Japanese, so such a transcript needs no model call. */
export function scriptLanguage(text: string): AsrLanguage | null {
	return /[ぁ-ゖァ-ヺ]/.test(text) ? "ja" : null;
}

export function transcriptLanguageMessages(text: string) {
	return [
		{
			role: "system" as const,
			content:
				policy + "\nOUTPUT_SCHEMA=" + JSON.stringify(z.toJSONSchema(result)),
		},
		{
			role: "user" as const,
			content: JSON.stringify({ languageCodes: codes, text }),
		},
	];
}

/** The judged languages; an unreadable answer judges nothing. */
export function parseTranscriptLanguages(value: unknown): string[] {
	if (typeof value !== "string" || Buffer.byteLength(value) > 4096) return [];
	try {
		return result.parse(parseLlmJson(value, 4096)).languages;
	} catch {
		return [];
	}
}

/** Only a transcript wholly in allowed languages is adopted. */
export function inAllowedLanguages(
	languages: readonly string[],
	allowed: readonly AsrLanguage[],
) {
	return (
		languages.length > 0 &&
		languages.every((l) => allowed.includes(l as AsrLanguage))
	);
}
