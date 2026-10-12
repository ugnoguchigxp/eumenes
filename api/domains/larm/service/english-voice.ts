import type { TtsVoices } from "../contracts";

/** User-specified fixed pairing, enforced using provider metadata rather than voice names. */
export function pairedEnglishVoice(
	japanese: TtsVoices,
	english: TtsVoices,
	voice?: string,
) {
	const selected = japanese.voices.find(
		(v) => v.id === (voice || japanese.default_voice),
	);
	const presentation = selected?.voice_presentation;
	if (
		presentation !== "masculine" &&
		presentation !== "feminine" &&
		presentation !== "androgynous"
	)
		throw new Error("larm_tts_voice_presentation_unavailable");
	const masculine = presentation === "masculine";
	const id = masculine ? "Jasper" : "Rosie";
	const target = english.voices.find((v) => v.id === id);
	if (!target) throw new Error("larm_tts_voice_missing");
	if (target.voice_presentation !== (masculine ? "masculine" : "feminine"))
		throw new Error("larm_tts_voice_presentation_mismatch");
	return target.id;
}
