import { z } from "zod";
import type { LarmPort } from "../contracts";
import { sentenceLanguageDecisionSchema } from "../contracts";
import { readJson } from "./guards";
import type { fetchCatalog } from "./connect";
import type { WithProvider, Infer } from "./speech";

const unchangedInput = {
	truncated: z.literal(false).optional(),
	state_tokens_dropped: z.literal(0).optional(),
};
const resultSchema = z
	.object({
		model: z.string().optional(),
		...unchangedInput,
		usage: z.object(unchangedInput).passthrough().optional(),
		answers: z
			.object({
				language: z
					.object({ type: z.literal("choice"), choice: z.enum(["ja", "en"]) })
					.passthrough(),
			})
			.passthrough(),
	})
	.passthrough();

/** System One choice contract, with a separately selected Provider binding. */
export function createSentenceLanguageOperations({
	withProvider,
	infer,
	catalog,
}: {
	withProvider: WithProvider;
	infer: Infer;
	catalog: (signal: AbortSignal) => ReturnType<typeof fetchCatalog>;
}): Pick<LarmPort, "classifySentenceLanguage" | "speechRouting"> {
	return {
		async speechRouting(signal) {
			signal.throwIfAborted();
			const { catalogProviders } = await catalog(signal);
			signal.throwIfAborted();
			return {
				englishTts: catalogProviders.some(
					(p) =>
						p.capability === "speech.tts.english" &&
						p.protocol === "openai.audio-speech.v1" &&
						p.endpoint === "/v1/audio/speech",
				),
				languageProviders: catalogProviders
					.filter(
						(p) =>
							p.capability === "decision.sentence-language" &&
							p.protocol === "larm.system-one.v1" &&
							p.endpoint === "/v1/systemone" &&
							typeof p.name === "string" &&
							!!p.name &&
							p.name !== "system-one" &&
							typeof p.model === "string" &&
							!!p.model,
					)
					.map((p) => ({ name: String(p.name), model: String(p.model) })),
			};
		},
		async classifySentenceLanguage(text, signal, options) {
			if (!text.trim() || text.length > 65536)
				throw new Error("speech_language_invalid");
			return withProvider(
				"sentence-language",
				signal,
				async (p, connectionId) => {
					const started = performance.now();
					const response = await infer(
						p,
						"systemone",
						{
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								model: p.model,
								state: text,
								questions: {
									language: {
										type: "choice",
										instructions:
											"Classify the language of this whole text as Japanese or English.",
										criteria: { ja: "Japanese", en: "English" },
									},
								},
							}),
						},
						signal,
						connectionId,
						options,
					);
					const result = resultSchema.safeParse(await readJson(response));
					if (
						!result.success ||
						(result.data.model !== undefined && result.data.model !== p.model)
					)
						throw new Error("speech_language_invalid");
					const answer = result.data.answers.language;
					const parsed = sentenceLanguageDecisionSchema.safeParse({
						language: answer.choice,
						model: p.model,
						latencyMs: performance.now() - started,
					});
					if (!parsed.success) throw new Error("speech_language_invalid");
					signal.throwIfAborted();
					return parsed.data;
				},
			);
		},
	};
}
