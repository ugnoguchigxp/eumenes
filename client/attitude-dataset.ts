import { z } from "zod";
import { callJson, json, withQuery, type Transport } from "./transport";

const count = z.number().int().nonnegative();
const reviewStatus = z.enum(["unreviewed", "held", "reviewed"]);
const split = z.enum(["train", "calibration", "eval"]);
const tally = z.record(z.string(), count);
const statusSchema = z.looseObject({
	enabled: z.boolean(),
	target: count,
	successful: count,
	unreviewed: count,
	reviewed: count,
	held: count,
	skipped: count,
	skip_reasons: tally,
	pending: count,
	failed: count,
	storage_errors: count,
	score_notice: z.string(),
});
const reportSchema = statusSchema.extend({
	contrasting_context_groups: z.array(
		z.looseObject({ sample_ids: z.array(z.string()), reviewed: count }),
	),
	short_texts: count,
	dominant_class_fraction: z.number().nullable(),
	classes: tally,
	rejections: tally,
	coverage: tally,
	missing_classes: z.array(z.string()),
	missing_coverage: z.array(z.string()),
	differences: z.array(z.unknown()),
	granularity: z.looseObject({ answer: count, chunk: count }),
	splits: tally,
	warnings: z.array(z.string()),
});
const sampleSummarySchema = z.looseObject({
	sample_id: z.string(),
	review_status: reviewStatus,
	revision: count,
	granularity: z.enum(["chunk", "answer"]),
	chunk_order: count.nullable(),
});
const sampleSchema = z.looseObject({
	sample_id: z.string(),
	conversation_id: z.string(),
	revision: count,
	primary_label: z.string().nullable(),
	acceptable_labels: z.array(z.string()),
	expression_transition: z.enum(["initial", "hold", "change"]).nullable(),
	review_status: reviewStatus,
	correction_reason: z.string().nullable(),
	template_group_id: z.string(),
	template_group_confirmed: z.boolean(),
	coverage_tags: z.array(z.string()),
	current_chunk: z.string(),
	split: split.nullable(),
});
const reviewResultSchema = z.looseObject({
	sample_id: z.string(),
	revision: count,
	review_status: reviewStatus,
});
const splitResultSchema = z.looseObject({
	counts: tally,
	groups: count,
	warning: z.string().nullable(),
});
const exportSchema = z.looseObject({
	jsonl: z.string(),
	partitions: z.looseObject({
		train: z.string(),
		calibration: z.string(),
		eval: z.string(),
	}),
	report: reportSchema,
	schema: z.record(z.string(), z.unknown()),
});

export function attitudeDatasetClient(t: Transport) {
	const root = "/api/attitude-dataset";
	return {
		attitudeStatus: () => callJson(t, statusSchema, `${root}/status`),
		attitudeStart: () => callJson(t, statusSchema, `${root}/start`, json({})),
		attitudeStop: () => callJson(t, statusSchema, `${root}/stop`, json({})),
		attitudeSamples: () =>
			callJson(t, z.array(sampleSummarySchema), `${root}/samples`),
		attitudeSample: (id: string, showPredictions = false) =>
			callJson(
				t,
				sampleSchema,
				withQuery(`${root}/samples/${encodeURIComponent(id)}`, {
					predictions: showPredictions ? "show" : undefined,
				}),
			),
		attitudeReview: (id: string, review: unknown) =>
			callJson(
				t,
				reviewResultSchema,
				`${root}/samples/${encodeURIComponent(id)}/review`,
				json(review),
			),
		attitudeReport: () => callJson(t, reportSchema, `${root}/report`),
		attitudeSplit: () =>
			callJson(t, splitResultSchema, `${root}/split`, json({})),
		attitudeExport: () => callJson(t, exportSchema, `${root}/export`),
	};
}
