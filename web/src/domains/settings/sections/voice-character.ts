import type { EumenesClient } from "../../../../../client";
import type { Change } from "../shared";

export function updateVoiceCharacter(
	id: string,
	voiceCatalog: Awaited<ReturnType<EumenesClient["larmVoices"]>> | undefined,
	change: Change,
) {
	const selected = voiceCatalog?.voices.find(
		(v) => v.id === (id || voiceCatalog.default_voice),
	);
	change((s) => {
		s.larm.voice = id;
		s.larm.style = selected?.default_style;
		for (const [field, capability] of [
			["speed", "speed"],
			["pitchScale", "pitch_scale"],
			["intonationScale", "intonation_scale"],
		] as const) {
			const range = selected?.capabilities[capability];
			const current = s.larm[field];
			if (
				range &&
				current !== undefined &&
				(current < range.minimum || current > range.maximum)
			)
				s.larm[field] = range.default;
		}
	});
}
