import { z } from "zod";
export const musicRequest = z.strictObject({
	question: z.string().trim().min(1).max(8000),
});
export const musicPlan = z.strictObject({
	title: z.string().trim().min(1).max(120),
	description: z.string().trim().min(1).max(500),
	prompt: z.string().trim().min(1).max(4000),
	durationSeconds: z.number().positive().finite(),
});
/** V1 remains immutable for installed capability revisions and queued work. */
export const musicPlanV2 = musicPlan.extend({
	durationSeconds: z.number().int().min(1).max(600),
	instrumental: z.boolean(),
	lyrics: z.string().max(4000).optional(),
	language: z.string().min(2).max(32).optional(),
});
/** V3 supports LARM's audio routing without interpreting prompt text in code. */
export const musicPlanV3 = musicPlan
	.omit({ durationSeconds: true })
	.extend({
		task: z.enum(["music", "sound-effect"]),
		instrumental: z.boolean().optional(),
		durationSeconds: z.number().finite().min(1).max(600).optional(),
		lyrics: z.string().max(4000).optional(),
		language: z.string().min(2).max(32).optional(),
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
		if (v.task === "music" && v.instrumental === undefined)
			ctx.addIssue({
				code: "custom",
				path: ["instrumental"],
				message: "音楽には歌声の有無を指定してください。",
			});
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
export const musicPlaybackPlan = z.strictObject({
	title: z.string().trim().min(1).max(120),
	q: z.string().max(512),
	tags: z.array(z.string().min(1).max(64)).max(32),
	favorite: z.boolean().nullable(),
	sort: z.enum(["createdAt", "relevance"]),
	order: z.enum(["asc", "desc"]),
});
