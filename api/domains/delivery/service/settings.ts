import { z } from "zod";
import data from "../data/speech-delivery.v1.json" with { type: "json" };
import {
	emotionSchema,
	avatarMotionSchema,
	speechToneSchema,
} from "../contracts";
export const speechDeliverySettings = z
	.object({
		version: z.literal(1),
		instructions: z.string().min(1),
		criteria: z.record(emotionSchema, z.string().min(1)),
		performance: z.record(
			emotionSchema,
			z.object({ motion: avatarMotionSchema, tone: speechToneSchema }).strict(),
		),
		presets: z.record(
			speechToneSchema,
			z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
		),
	})
	.strict()
	.parse(data);
