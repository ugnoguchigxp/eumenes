import {
	musicGenerationInput,
	type MusicProviders,
} from "../contracts/music-generation";
import type { TestInput } from "../contracts/playground";
export function musicRequest(input: TestInput, catalog: MusicProviders) {
	if (input.audio) throw new Error("music_request_invalid");
	const {
		text,
		task,
		instrumental,
		lyrics,
		language,
		durationSeconds,
		outputFormat,
		quality,
		bpm,
		key,
		timeSignature,
		seed,
		providerOptions,
	} = input;
	const parsed = musicGenerationInput.safeParse({
		prompt: text,
		task,
		instrumental,
		lyrics,
		language,
		durationSeconds,
		outputFormat,
		quality,
		bpm,
		key,
		timeSignature,
		seed,
		providerOptions,
	});
	if (!parsed.success) throw new Error("music_request_invalid");
	const v = parsed.data;
	const kind =
		v.task === "sound-effect"
			? "sound-effect"
			: v.instrumental === false
				? "vocals"
				: "music";
	const models = catalog.providers
		.flatMap((p) => p.models ?? [])
		.filter((m) => m.task === kind);
	if (!models.length) throw new Error("music_models_unavailable");
	if (
		v.durationSeconds !== undefined &&
		models.every((m) => v.durationSeconds! > m.maxDurationSeconds)
	)
		throw new Error("music_duration_exceeded");
	return {
		...v,
		model: "auto",
		task: v.task ?? "music",
		...(kind === "sound-effect"
			? {}
			: { instrumental: v.instrumental ?? true }),
		outputFormat: v.outputFormat ?? "opus",
		quality: v.quality ?? "balanced",
	};
}
