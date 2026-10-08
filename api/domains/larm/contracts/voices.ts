import { z } from "zod";
const id = z.string().trim().min(1).max(200);
const range = (minimum: number, maximum: number) =>
	z
		.object({
			minimum: z.number().min(minimum).max(maximum),
			maximum: z.number().min(minimum).max(maximum),
			default: z.number().min(minimum).max(maximum),
		})
		.refine((r) => r.minimum <= r.default && r.default <= r.maximum);
const voiceSchema = z
	.object({
		id,
		display_name: id.optional(),
		name: id.optional(),
		speaker_uuid: id.optional(),
		language: id.optional(),
		default_style: id.optional(),
		style_id: z.number().int().nonnegative().optional(),
		styles: z
			.array(
				z.object({
					id,
					display_name: id,
					style_id: z.number().int().nonnegative().optional(),
				}),
			)
			.max(100)
			.default([]),
		capabilities: z
			.object({
				speed: range(0.5, 2).optional(),
				pitch_scale: range(-0.15, 0.15).optional(),
				intonation_scale: range(0, 2).optional(),
			})
			.default({}),
		voice_presentation: z
			.enum(["masculine", "feminine", "androgynous", "unspecified"])
			.optional(),
		credit: z.string().max(2048).optional(),
	})
	.transform((v) => ({ ...v, display_name: v.display_name ?? v.name ?? v.id }));
export const ttsVoicesSchema = z
	.object({
		model: id,
		default_voice: id.optional(),
		voices: z.array(voiceSchema).max(1000),
	})
	.refine(
		(c) =>
			new Set(c.voices.map((v) => v.id)).size === c.voices.length &&
			(!c.default_voice || c.voices.some((v) => v.id === c.default_voice)) &&
			c.voices.every(
				(v) =>
					new Set(v.styles.map((s) => s.id)).size === v.styles.length &&
					(!v.default_style || v.styles.some((s) => s.id === v.default_style)),
			),
	);
export type TtsVoices = z.infer<typeof ttsVoicesSchema>;
export type TtsVoice = TtsVoices["voices"][number];
export type TtsRange = NonNullable<TtsVoice["capabilities"]["speed"]>;
