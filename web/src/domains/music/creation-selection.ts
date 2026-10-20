import { musicGenerationInput } from "../../../../api/domains/music/contracts";
/** Artifact events carry string values; validate the structured selection before submitting it. */
export function parseMusicSelection(
	prompt: unknown,
	generation: unknown,
): Record<string, unknown> | null | undefined {
	if (generation === undefined) return undefined;
	try {
		if (typeof generation !== "string" || generation.length > 4500) return null;
		const value: unknown = JSON.parse(generation);
		if (!value || typeof value !== "object" || Array.isArray(value))
			return null;
		const parsed = musicGenerationInput.parse({ ...value, prompt });
		const { prompt: _prompt, ...fields } = parsed;
		return fields;
	} catch {
		return null;
	}
}
