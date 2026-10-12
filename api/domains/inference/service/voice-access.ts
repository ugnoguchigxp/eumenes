import type { SettingsService, Settings } from "../../settings";
import type { LarmPort } from "../../larm";
import type { SpeechPreparation } from "../../delivery";
import type { Receipt, SpeechOverride } from "../contracts";

export function createVoiceAccess({
	settings,
	port,
	standalone,
	standaloneReceipt,
}: {
	settings: SettingsService;
	port: (s: Settings) => LarmPort;
	standalone: (
		purpose: "tts",
		text: string,
		signal: AbortSignal,
		delta?: (text: string) => void,
		override?: SpeechOverride,
	) => Promise<string | Uint8Array>;
	standaloneReceipt: (
		purpose: "tts",
		text: string,
		signal: AbortSignal,
		delta?: (text: string) => void,
		override?: SpeechOverride,
		preparation?: SpeechPreparation,
	) => Promise<Receipt>;
}) {
	return {
		speechRouting: async (signal: AbortSignal) => {
			const snapshot = settings.get();
			const value = (await port(snapshot).speechRouting?.(signal)) ?? {
				englishTts: false,
				languageProviders: [],
			};
			if (JSON.stringify(snapshot.larm) !== JSON.stringify(settings.get().larm))
				throw new Error("stale_voice_settings");
			return value;
		},
		voices: async (signal: AbortSignal, language?: "ja" | "en") => {
			const snapshot = settings.get();
			const value = await port(snapshot).voices?.(signal, language);
			if (!value) throw new Error("larm_voice_discovery_unsupported");
			if (JSON.stringify(snapshot.larm) !== JSON.stringify(settings.get().larm))
				throw new Error("stale_voice_settings");
			return value;
		},
		speak: (text: string, signal: AbortSignal, override?: SpeechOverride) =>
			standalone(
				"tts",
				text,
				signal,
				undefined,
				override,
			) as Promise<Uint8Array>,
		speakWithDelivery: async (
			text: string,
			signal: AbortSignal,
			preparation?: SpeechPreparation,
		) => {
			const receipt = await standaloneReceipt(
				"tts",
				text,
				signal,
				undefined,
				undefined,
				preparation,
			);
			return { wav: receipt.value as Uint8Array, delivery: receipt.delivery };
		},
	};
}
