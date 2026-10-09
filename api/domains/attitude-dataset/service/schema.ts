import { z } from "zod";
import { speechDeliverySchema } from "../../delivery";
const nullable = (type: string) => ({ type: [type, "null"] });
const labels = ["none", "warmth", "joy", "empathy", "curiosity", "surprise"];
const label = { enum: labels };
const maybeLabel = { enum: [...labels, null] };
const strings = { type: "array", items: { type: "string" } };
const six = {
	type: ["object", "null"],
	properties: Object.fromEntries(labels.map((k) => [k, { type: "number" }])),
	required: labels,
	additionalProperties: false,
};
const details = {
	type: "object",
	additionalProperties: false,
	properties: {
		valid: { type: "boolean" },
		...Object.fromEntries(
			[
				"model",
				"claimed_model",
				"encoder_revision",
				"head_revision",
				"calibration_revision",
				"input_mode",
				"precision",
				"method",
				"calibration_status",
				"score_kind",
			].map((k) => [k, nullable("string")]),
		),
		runtime: { anyOf: [strings, { type: "null" }] },
		preliminary: nullable("boolean"),
		calibrated: nullable("boolean"),
		logits: six,
		scores: six,
		top_label: maybeLabel,
		api_label: maybeLabel,
		answer_confidence: nullable("number"),
		candidate_restricted: nullable("boolean"),
		truncated: nullable("boolean"),
		state_tokens_dropped: nullable("number"),
		inference_ms: nullable("number"),
	},
};
const selected = z.toJSONSchema(speechDeliverySchema);
const properties = {
	schema_version: { const: 1 },
	...Object.fromEntries(
		[
			"sample_id",
			"conversation_id",
			"turn_id",
			"judged_at",
			"template_group_id",
			"automatic_template_group_id",
			"current_chunk",
			"sent_current_text",
		].map((k) => [k, { type: "string" }]),
	),
	chunk_order: nullable("integer"),
	granularity: { enum: ["chunk", "answer"] },
	template_group_confirmed: { type: "boolean" },
	review_context: {
		type: "array",
		items: {
			type: "object",
			required: ["role", "text"],
			properties: {
				role: { enum: ["user", "assistant"] },
				text: { type: "string" },
			},
			additionalProperties: false,
		},
	},
	user_utterance: nullable("string"),
	previous_assistant_chunk: nullable("string"),
	criteria: { type: "object", additionalProperties: { type: "string" } },
	candidate_order: strings,
	text_transform: { const: "raw-current-excerpt-600" },
	client_excerpted: { type: "boolean" },
	decision: details,
	adopted: {
		type: ["object", "null"],
		description:
			"receipt採用を確認した演出。未確認はnull。実再生を意味しない。",
		properties: {
			emotion: maybeLabel,
			motion: { type: "string" },
			tone: {
				enum: ["natural", "bright", "gentle", "serious", "excited", null],
			},
			voice_application: {
				enum: ["preset", "baseline", "manual", "unmeasured", null],
			},
			source: { enum: ["laya", "ruri", "system-one", "fallback"] },
			reason: nullable("string"),
		},
	},
	selected_delivery: selected,
	rejection_reason: nullable("string"),
	collection_only: { type: "boolean" },
	round_trip_ms: { type: "number", minimum: 0 },
	tts_start_delay_ms: nullable("number"),
	primary_label: maybeLabel,
	acceptable_labels: { type: "array", items: label, uniqueItems: true },
	expression_transition: { enum: ["initial", "hold", "change", null] },
	review_status: { enum: ["unreviewed", "held", "reviewed"] },
	correction_reason: nullable("string"),
	coverage_tags: strings,
	revision: { type: "integer" },
	split: { enum: ["train", "calibration", "eval", null] },
};
export const exportSchema = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	title: "Eumenes Ruri speaking attitude sample v1",
	type: "object",
	additionalProperties: false,
	properties,
	required: Object.keys(properties),
	"x-deduplication":
		"HMAC-SHA256(dataset salt, [conversationId,turnId,granularity,chunkOrder]); one unit across retry/replay; no benchmark identity",
	"x-split-policy":
		"Connected components of conversation + automatic normalized template + human verified template; deterministic size-balanced 60/20/20, reviewed only. Never use eval for fitting/calibration/threshold selection.",
	"x-score-notice":
		"Synthetic provisional calibration, not real conversation accuracy probability. Missing metadata and unreviewed labels are null.",
};
