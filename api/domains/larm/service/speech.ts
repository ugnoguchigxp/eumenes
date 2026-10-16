import type { LarmCallOptions, LarmPort, TtsVoices } from "../contracts";
import { pairedEnglishVoice } from "./english-voice";
import type { Provider, ProviderName } from "./profiles";
import { readBounded } from "../../../infrastructure/bounded-read";
import { getLogger } from "../../../infrastructure/logger";
const log = getLogger("larm");
export type WithProvider = <T>(
	name: ProviderName,
	signal: AbortSignal,
	use: (p: Provider, connectionId: string) => Promise<T>,
) => Promise<T>;
export type Infer = (
	p: Provider,
	operation: string,
	init: RequestInit,
	signal: AbortSignal,
	connectionId: string,
	options?: LarmCallOptions,
) => Promise<Response>;
export function createSpeechSynthesizer({
	withProvider,
	infer,
	japaneseVoice,
	readVoices,
	voiceCatalogs,
	config,
	voice,
}: {
	withProvider: WithProvider;
	infer: Infer;
	/** The Japanese voice of the lease already held by the English synthesis. */
	japaneseVoice: () => Provider | undefined;
	readVoices: (p: Provider, signal: AbortSignal) => Promise<TtsVoices>;
	voiceCatalogs: WeakMap<Provider, TtsVoices>;
	config: {
		speed?: number;
		style?: string;
		pitchScale?: number;
		intonationScale?: number;
	};
	voice?: string;
}): LarmPort["speak"] {
	return (text, signal, options) => {
		return withProvider(
			options?.speechLanguage === "en" ? "tts-english" : "tts",
			signal,
			async (p, connectionId) => {
				if (!text.trim() || text.length > 4096)
					throw new Error("larm_tts_input_invalid");
				const english = options?.speechLanguage === "en";
				const synthesis = { ...config, ...options?.speechOverride };
				const requestedVoice =
					options?.speechOverride &&
					Object.hasOwn(options.speechOverride, "voice")
						? options.speechOverride.voice || undefined
						: voice;
				let selectedVoice = requestedVoice ?? p.voice;
				const voicevox = !english && p.model === "voicevox-core";
				if (english) {
					// Reading the paired Japanese catalog must not reacquire the lease
					// this call already holds: a renewal would wait on this very use.
					const jp = japaneseVoice();
					if (!jp) throw new Error("larm_credential_expired");
					const japanese =
						voiceCatalogs.get(jp) ?? (await readVoices(jp, signal));
					const englishCatalog =
						voiceCatalogs.get(p) ?? (await readVoices(p, signal));
					selectedVoice = pairedEnglishVoice(
						japanese,
						englishCatalog,
						requestedVoice,
					);
					signal.throwIfAborted();
				}
				let catalog: TtsVoices | undefined;
				if (voicevox || !selectedVoice) {
					try {
						catalog = voiceCatalogs.get(p) ?? (await readVoices(p, signal));
					} catch (error) {
						// The catalog only validates and clamps; a voice that is already
						// chosen can still be synthesized when the catalog is refused.
						signal.throwIfAborted();
						log.warn(
							"larm.voice_catalog_unavailable",
							{
								reason: "voice_catalog_unavailable",
								kind: selectedVoice
									? "continue_with_selected_voice"
									: "no_voice",
							},
							error,
						);
						if (!selectedVoice) throw error;
					}
				}
				const catalogUnavailable = (voicevox || !selectedVoice) && !catalog;
				if (!requestedVoice && voicevox && !english)
					selectedVoice = catalog?.default_voice ?? selectedVoice;
				if (!selectedVoice) selectedVoice = p.voice = catalog?.default_voice;
				if (!selectedVoice) throw new Error("larm_tts_voice_unconfigured");
				const speaker = catalog?.voices.find((v) => v.id === selectedVoice);
				if (voicevox && !catalogUnavailable && !speaker) {
					log.warn("larm.tts_voice_missing", {
						kind: selectedVoice,
						count: catalog?.voices.length,
						reason: `catalog: ${(catalog?.voices ?? [])
							.slice(0, 12)
							.map((v) => v.id)
							.join(",")}`.slice(0, 250),
					});
					throw new Error("larm_tts_voice_missing");
				}
				if (
					voicevox &&
					!catalogUnavailable &&
					synthesis.style &&
					!speaker?.styles.some((s) => s.id === synthesis.style)
				)
					throw new Error("larm_tts_voice_style_invalid");
				let intonationScale = synthesis.intonationScale;
				const selectedSpeed =
					voicevox && options?.speed !== undefined
						? options.speed
						: english
							? 1
							: synthesis.speed;
				const selectedPitch =
					voicevox && options?.pitchScale !== undefined
						? options.pitchScale
						: synthesis.pitchScale;
				const boundedParameter = (
					value: number | undefined,
					key: "speed" | "pitch_scale",
					override: boolean,
				) => {
					if (value === undefined || !override) return value;
					const range = speaker?.capabilities[key];
					return range
						? Math.max(range.minimum, Math.min(range.maximum, value))
						: value;
				};
				const speechSpeed = boundedParameter(
					selectedSpeed,
					"speed",
					voicevox && options?.speed !== undefined,
				);
				const speechPitch = boundedParameter(
					selectedPitch,
					"pitch_scale",
					voicevox && options?.pitchScale !== undefined,
				);
				if (options?.intonationScale !== undefined) {
					const range = speaker?.capabilities.intonation_scale;
					intonationScale = Math.max(
						range?.minimum ?? 0,
						Math.min(range?.maximum ?? 2, options.intonationScale),
					);
				}
				for (const [key, value] of [
					["speed", speechSpeed],
					["pitch_scale", speechPitch],
					["intonation_scale", intonationScale],
				] as const) {
					if (voicevox && value !== undefined) {
						const range = speaker?.capabilities[key];
						if (
							!Number.isFinite(value) ||
							(range && (value < range.minimum || value > range.maximum))
						)
							throw new Error("larm_tts_parameter_invalid");
					}
				}
				const response = await infer(
					p,
					"audio/speech",
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							model: p.model,
							input: text,
							voice: selectedVoice,
							...(speechSpeed !== undefined ? { speed: speechSpeed } : {}),
							...(voicevox && synthesis.style
								? { style: synthesis.style }
								: {}),
							...(voicevox && speechPitch !== undefined
								? { pitch_scale: speechPitch }
								: {}),
							...(voicevox && intonationScale !== undefined
								? { intonation_scale: intonationScale }
								: {}),
							response_format: "wav",
						}),
					},
					signal,
					connectionId,
					{ ...options, speechVoice: selectedVoice },
				);
				const bytes = await readBounded(response.body, {
					limit: 16_000_000,
					tooLarge: "larm_response_too_large",
					missing: "larm_empty_response",
				});
				if (
					bytes.length < 44 ||
					String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF" ||
					String.fromCharCode(...bytes.subarray(8, 12)) !== "WAVE"
				)
					throw new Error("tts_audio_invalid");
				return bytes;
			},
		);
	};
}
