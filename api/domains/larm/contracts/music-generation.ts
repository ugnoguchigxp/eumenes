import { z } from "zod";

/** LARM request contract; runtime/model selection belongs to LARM. */
export const musicGenerationInput = z
	.strictObject({
		prompt: z.string().trim().min(1).max(16384),
		task: z.enum(["music", "sound-effect"]).optional(),
		instrumental: z.boolean().optional(),
		lyrics: z.string().max(4000).optional(),
		language: z.string().min(2).max(32).optional(),
		durationSeconds: z.number().finite().min(1).max(600).optional(),
		outputFormat: z.enum(["opus", "wav", "flac", "mp3"]).optional(),
		quality: z.enum(["fast", "balanced", "high"]).optional(),
		bpm: z.number().int().min(20).max(300).optional(),
		key: z.string().min(1).max(32).optional(),
		timeSignature: z
			.string()
			.regex(/^\d{1,2}(?:\/\d{1,2})?$/)
			.optional(),
		seed: z.number().int().min(0).max(2147483647).optional(),
		providerOptions: z
			.strictObject({ guidance_scale: z.number().min(0).max(10).optional() })
			.optional(),
	})
	.superRefine((v, ctx) => {
		if (
			v.lyrics !== undefined &&
			(v.task === "sound-effect" || v.instrumental !== false)
		)
			ctx.addIssue({
				code: "custom",
				path: ["lyrics"],
				message: "歌詞はボーカル生成だけに指定できます。",
			});
		if (v.task === "sound-effect" && v.language !== undefined)
			ctx.addIssue({
				code: "custom",
				path: ["language"],
				message: "効果音に歌詞の言語は指定できません。",
			});
	});
export const musicProviders = z.object({
	providers: z.array(
		z.object({
			id: z.string().min(1),
			models: z
				.array(
					z.object({
						id: z.string().min(1),
						task: z.enum(["music", "vocals", "sound-effect"]),
						defaultDurationSeconds: z.number().positive().optional(),
						maxDurationSeconds: z.number().positive(),
					}),
				)
				.optional(),
		}),
	),
});
export type MusicProviders = z.infer<typeof musicProviders>;
