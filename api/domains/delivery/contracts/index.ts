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
export const emotionSchema = z.enum([
	"none",
	"warmth",
	"joy",
	"empathy",
	"curiosity",
	"surprise",
]);
export type Emotion = z.infer<typeof emotionSchema>;
export type DeliveryContext = {
	answer: string;
	turns: Array<{ role: "user" | "assistant"; text: string }>;
};
/** Internal preparation; a reused delivery must come from an adopted receipt. */
export type SpeechPreparation = {
	context?: DeliveryContext;
	collection?: {
		conversationId: string;
		turnId: string;
		chunkOrder: number | null;
		granularity: "chunk" | "answer";
		previousAssistantChunk?: string;
	};
	delivery?: SpeechDelivery;
};
export const speechDeliverySchema = z.object({
	id: z.uuid(),
	version: z.literal(2).optional(),
	emotion: emotionSchema.optional(),
	emotionConfidence: z.number().min(0).max(1).optional(),
	motion: avatarMotionSchema,
	tone: speechToneSchema,
	source: z.enum(["laya", "ruri", "system-one", "fallback"]),
	reason: z
		.enum([
			"unavailable",
			"timeout",
			"invalid",
			"low-confidence",
			"failed",
			"not-expressive",
			"candidate-restricted",
		])
		.optional(),
	confidence: z.number().min(0).max(1),
	motionConfidence: z.number().min(0).max(1).optional(),
	toneConfidence: z.number().min(0).max(1).optional(),
	model: z.string().nullable().optional(),
	calibrationStatus: z.string().nullable().optional(),
	latencyMs: z.number().int().nonnegative(),
});
export type AvatarMotion = z.infer<typeof avatarMotionSchema>;
export type SpeechDelivery = z.infer<typeof speechDeliverySchema>;
export type ChoiceQuestions = Record<
	string,
	{ type: "choice"; instructions: string; criteria: Record<string, string> }
>;

/** None and uncertain judgments never become a visible emotion. */
export function acceptedEmotion(delivery: SpeechDelivery) {
	return delivery.version === 2 &&
		delivery.source !== "fallback" &&
		delivery.emotion &&
		delivery.emotion !== "none" &&
		(delivery.emotionConfidence ?? 0) >= 0.6
		? delivery.emotion
		: null;
}

export type Judge = (
	state: Record<string, string>,
	questions: ChoiceQuestions,
	signal: AbortSignal,
) => Promise<unknown>;
