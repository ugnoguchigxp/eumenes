import { z } from "zod";

export const avatarMotionSchema = z.enum([
	"neutral",
	"listening",
	"thinking",
	"speaking",
	"curious",
	"distant",
	"downcast",
	"greeting",
	"agreeing",
	"joyful",
	"surprised",
	"shy",
	"sleepy",
]);
export const speechToneSchema = z.enum([
	"natural",
	"bright",
	"gentle",
	"serious",
	"excited",
]);
export const speechDeliverySchema = z.object({
	id: z.uuid(),
	motion: avatarMotionSchema,
	tone: speechToneSchema,
	source: z.enum(["laya", "fallback"]),
	reason: z
		.enum(["unavailable", "timeout", "invalid", "low-confidence", "failed"])
		.optional(),
	confidence: z.number().min(0).max(1),
	latencyMs: z.number().int().nonnegative(),
});
export type AvatarMotion = z.infer<typeof avatarMotionSchema>;
export type SpeechDelivery = z.infer<typeof speechDeliverySchema>;
export type ChoiceQuestions = Record<
	string,
	{ type: "choice"; instructions: string; criteria: Record<string, string> }
>;
