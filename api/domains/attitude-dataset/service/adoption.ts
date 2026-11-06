import type { SpeechDelivery } from "../../delivery";
import type { VoiceAdoption } from "../contracts";
export type SavedAdoption = { delivery: SpeechDelivery; voice?: VoiceAdoption };
export const readAdoption = (value: string): SavedAdoption => {
	const saved = JSON.parse(value);
	return "delivery" in saved ? saved : { delivery: saved };
};
export const adoption = (d: SpeechDelivery, voice?: VoiceAdoption) => ({
	emotion: d.emotion,
	motion: d.motion,
	tone: voice?.tone ?? null,
	voice_application: voice?.application ?? null,
	source: d.source,
	reason: d.reason ?? null,
});
