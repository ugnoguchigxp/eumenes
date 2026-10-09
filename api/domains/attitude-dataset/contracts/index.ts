import { z } from "zod";
import {
	emotionSchema,
	type DecisionDetails,
	type SpeechDelivery,
	type SpeechPreparation,
} from "../../delivery";
export const coverageTags = [
	"short",
	"technical",
	"celebration",
	"recovery",
	"loss",
	"curiosity",
	"surprise",
	"negation-quotation",
	"celebration-to-instructions",
	"contrast-same-text",
] as const;
export const reviewSchema = z
	.object({
		revision: z.number().int().nonnegative(),
		primary_label: emotionSchema.nullable(),
		acceptable_labels: z
			.array(emotionSchema)
			.max(6)
			.refine((a) => new Set(a).size === a.length),
		expression_transition: z.enum(["initial", "hold", "change"]).nullable(),
		review_status: z.enum(["unreviewed", "held", "reviewed"]),
		correction_reason: z.string().max(2000).nullable(),
		template_group_id: z.string().trim().min(1).max(200),
		template_group_confirmed: z.boolean(),
		coverage_tags: z
			.array(z.enum(coverageTags))
			.max(10)
			.refine((tags) => new Set(tags).size === tags.length),
	})
	.strict()
	.refine(
		(r) =>
			r.review_status !== "reviewed" ||
			(r.primary_label !== null &&
				r.acceptable_labels.includes(r.primary_label) &&
				r.expression_transition !== null &&
				r.template_group_confirmed),
		"review_incomplete",
	)
	.refine(
		(r) =>
			r.review_status !== "unreviewed" ||
			(r.primary_label === null &&
				r.acceptable_labels.length === 0 &&
				r.expression_transition === null),
		"unreviewed_labels_must_be_null",
	);
export type Review = Omit<z.infer<typeof reviewSchema>, "revision">;
export type Identity = NonNullable<SpeechPreparation["collection"]>;
export type VoiceAdoption = {
	tone: SpeechDelivery["tone"] | null;
	application: "preset" | "baseline" | "manual" | "unmeasured";
};
export type Sample = Review & {
	schema_version: 1;
	sample_id: string;
	conversation_id: string;
	turn_id: string;
	chunk_order: number | null;
	judged_at: string;
	granularity: "chunk" | "answer";
	automatic_template_group_id: string;
	review_context: Array<{ role: "user" | "assistant"; text: string }>;
	user_utterance: string | null;
	previous_assistant_chunk: string | null;
	current_chunk: string;
	sent_current_text: string;
	criteria: Record<string, string>;
	candidate_order: string[];
	text_transform: "raw-current-excerpt-600";
	client_excerpted: boolean;
	decision: DecisionDetails;
	adopted: {
		emotion: SpeechDelivery["emotion"];
		motion: SpeechDelivery["motion"];
		tone: SpeechDelivery["tone"] | null;
		voice_application: VoiceAdoption["application"] | null;
		source: SpeechDelivery["source"];
		reason: string | null;
	} | null;
	selected_delivery: SpeechDelivery;
	rejection_reason: string | null;
	collection_only: boolean;
	round_trip_ms: number;
	tts_start_delay_ms: number | null;
	revision: number;
	split: "train" | "calibration" | "eval" | null;
};
