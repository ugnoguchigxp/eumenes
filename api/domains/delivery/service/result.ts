import { z } from "zod";
import { emotionSchema } from "../contracts";
export const RURI_MODEL = "ruri-v3-30m-speaking-attitude";
const six = (value: z.ZodNumber) =>
	z.object(
		Object.fromEntries(
			emotionSchema.options.map((key) => [key, value]),
		) as Record<import("../contracts").Emotion, z.ZodNumber>,
	);
const identitySchema = z.object({
	model: z.string().max(200).optional(),
	claimed_model: z.string().max(200).optional(),
});
const metadata = z.object({
	model: z.string().max(200).optional(),
	claimed_model: z.string().max(200).optional(),
	truncated: z.boolean().optional(),
	state_tokens_dropped: z.number().nonnegative().optional(),
	usage: z
		.object({
			truncated: z.boolean().optional(),
			state_tokens_dropped: z.number().nonnegative().optional(),
		})
		.optional(),
	answers: z.object({
		emotion: z.object({
			type: z.literal("choice"),
			choice: emotionSchema,
			confidence: z.number().min(0).max(1),
			answer_confidence: z.number().min(0).max(1),
			logits: six(z.number()).optional(),
			probabilities: six(z.number().min(0).max(1))
				.refine(
					(scores) =>
						Math.abs(Object.values(scores).reduce((a, b) => a + b, 0) - 1) <=
						0.001,
				)
				.optional(),
			score_kind: z.string().max(200).optional(),
			calibrated: z.boolean().optional(),
			calibration_label_status: z.string().max(200).optional(),
			candidate_restricted: z.boolean().optional(),
		}),
	}),
	routing: z
		.object({
			model: z.string().max(200).optional(),
			revision: z.string().max(200).optional(),
			head_revision: z.string().max(200).optional(),
			calibration_revision: z.string().max(200).optional(),
			input_mode: z.string().max(100).optional(),
			method: z.string().max(100).optional(),
			preliminary: z.boolean().optional(),
			precision: z.string().max(100).optional(),
			execution_providers: z.array(z.string().max(100)).max(10).optional(),
			inference_ms: z.number().nonnegative().optional(),
		})
		.optional(),
});
/** An explicit allowlist. Never retain the raw provider response. Unknown metadata stays null. */
export function decisionDetails(response: unknown) {
	const identity = identitySchema.safeParse(response);
	const parsed = metadata.safeParse(response);
	const r = parsed.success ? parsed.data : undefined;
	const a = r?.answers.emotion;
	const route = r?.routing;
	const scores = a?.probabilities ?? null;
	const logits = a?.logits ?? null;
	const top = logits
		? [...emotionSchema.options].sort((x, y) => logits[y] - logits[x])[0]!
		: null;
	const ruri =
		(identity.success
			? (identity.data.model ?? identity.data.claimed_model)
			: null) === RURI_MODEL;
	const coherent =
		!ruri ||
		!!(
			scores &&
			logits &&
			top &&
			a &&
			scores[top] + 1e-6 >= Math.max(...Object.values(scores)) &&
			((a.choice === top &&
				Math.abs(a.answer_confidence - scores[top]) <= 0.001) ||
				(a.choice === "none" && top !== "none" && a.answer_confidence === 0))
		);
	const truncationFlags = [r?.truncated, r?.usage?.truncated].filter(
		(value): value is boolean => value !== undefined,
	);
	const droppedCounts = [
		r?.state_tokens_dropped,
		r?.usage?.state_tokens_dropped,
	].filter((value): value is number => value !== undefined);
	return {
		valid: !!r && coherent,
		// Malformed scores must not erase a known Ruri identity and fall back to a Laya attribution.
		model: identity.success ? (identity.data.model ?? null) : null,
		claimed_model: identity.success
			? (identity.data.claimed_model ?? null)
			: null,
		encoder_revision: route?.revision ?? null,
		head_revision: route?.head_revision ?? null,
		calibration_revision: route?.calibration_revision ?? null,
		input_mode: route?.input_mode ?? null,
		runtime: route?.execution_providers ?? null,
		precision: route?.precision ?? null,
		method: route?.method ?? null,
		preliminary: route?.preliminary ?? null,
		calibration_status: a?.calibration_label_status ?? null,
		calibrated: a?.calibrated ?? null,
		score_kind: a?.score_kind ?? null,
		logits,
		scores,
		top_label: top,
		api_label: a?.choice ?? null,
		answer_confidence: a?.answer_confidence ?? null,
		candidate_restricted: a?.candidate_restricted ?? null,
		truncated: truncationFlags.length ? truncationFlags.some(Boolean) : null,
		state_tokens_dropped: droppedCounts.length
			? Math.max(...droppedCounts)
			: null,
		inference_ms: route?.inference_ms ?? null,
	};
}
export type DecisionDetails = ReturnType<typeof decisionDetails>;
