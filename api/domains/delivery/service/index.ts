import { decisionDetails, RURI_MODEL } from "./result";
import { z } from "zod";
import { speechDeliverySettings } from "./settings";
import {
	acceptedEmotion,
	type Judge,
	emotionSchema,
	type DeliveryContext,
	type ChoiceQuestions,
	type SpeechDelivery,
} from "../contracts";
export { acceptedEmotion };
export type { Judge };

export const speechQuestions: ChoiceQuestions = {
	emotion: {
		type: "choice",
		instructions: speechDeliverySettings.instructions,
		criteria: speechDeliverySettings.criteria,
	},
};
export const resultSchema = z.object({
	answers: z.object({
		emotion: z.object({
			type: z.literal("choice"),
			choice: emotionSchema,
			confidence: z.number().min(0).max(1),
			answer_confidence: z.number().min(0).max(1),
		}),
	}),
	model: z.string().optional(),
	truncated: z.boolean().optional(),
	state_tokens_dropped: z.number().nonnegative().optional(),
	usage: z
		.object({
			truncated: z.boolean().optional(),
			state_tokens_dropped: z.number().nonnegative().optional(),
		})
		.optional(),
});

export const emotionPerformance = speechDeliverySettings.performance;

/** Bound dynamic data without hiding the reply's ending or copying system instructions. */
function excerpt(value: string, limit: number) {
	const chars = Array.from(value.trim());
	if (chars.length <= limit) return value.trim();
	const half = Math.floor((limit - 1) / 2);
	return chars.slice(0, half).join("") + "…" + chars.slice(-half).join("");
}
export function deliveryState(text: string, context?: DeliveryContext) {
	const state: Record<string, string> = {};
	const turns = context?.turns.slice(-4).map((turn) => ({
		role: turn.role,
		text: excerpt(turn.text, 120),
	}));
	if (turns?.length) state.conversation = JSON.stringify(turns);
	state.current_chunk = excerpt(context?.answer || text, 600);
	state.response = excerpt(context?.answer || text, 600);
	if (
		(context?.turns.length ?? 0) > 4 ||
		(context?.turns
			.slice(-4)
			.some((t) => Array.from(t.text.trim()).length > 120) ??
			false) ||
		Array.from((context?.answer || text).trim()).length > 600
	)
		state.context_truncated = "true";
	return state;
}
export async function chooseSpeechDelivery(
	judge: Judge | undefined,
	text: string,
	signal: AbortSignal,
	budgetMs = 2000,
	context?: DeliveryContext,
): Promise<SpeechDelivery> {
	signal.throwIfAborted();
	const started = performance.now();
	const id = crypto.randomUUID();
	let details = decisionDetails(null);
	const fallback = (reason: SpeechDelivery["reason"]): SpeechDelivery => ({
		id,
		version: 2,
		emotion: "none",
		emotionConfidence: 0,
		motion: "neutral",
		tone: "natural",
		source: "fallback",
		reason,
		confidence: 0,
		model: details.model,
		calibrationStatus: details.calibration_status,
		latencyMs: Math.round(performance.now() - started),
	});
	if (!judge || !text.trim()) return fallback("unavailable");
	const questions = speechQuestions;

	const abort = new AbortController();
	const scoped = AbortSignal.any([signal, abort.signal]);
	const timer = setTimeout(
		() => abort.abort(new DOMException("decision deadline", "TimeoutError")),
		budgetMs,
	);
	let stopped = () => {};
	try {
		const pending = judge(deliveryState(text, context), questions, scoped);
		const response = await Promise.race([
			pending,
			new Promise<never>((_, reject) => {
				stopped = () => reject(scoped.reason);
				scoped.addEventListener("abort", stopped, { once: true });
				if (scoped.aborted) stopped();
			}),
		]);
		signal.throwIfAborted();
		if (abort.signal.aborted) return fallback("timeout");
		details = decisionDetails(response);
		const parsed = resultSchema.safeParse(response);
		if (
			!parsed.success ||
			parsed.data.truncated ||
			(parsed.data.state_tokens_dropped ?? 0) > 0 ||
			parsed.data.usage?.truncated ||
			(parsed.data.usage?.state_tokens_dropped ?? 0) > 0
		)
			return fallback("invalid");
		const choice = parsed.data.answers.emotion;

		if (
			(details.model ?? details.claimed_model) === RURI_MODEL &&
			(!details.logits || !details.scores)
		)
			return fallback("invalid");
		if (
			(details.model ?? details.claimed_model) === RURI_MODEL &&
			details.top_label &&
			!(details.top_label in questions.emotion!.criteria)
		)
			return {
				...fallback("invalid"),
				model: details.model,
				calibrationStatus: details.calibration_status,
			};
		if (
			(details.model ?? details.claimed_model) === RURI_MODEL &&
			!details.valid
		)
			return fallback("invalid");
		const confidence = choice.answer_confidence;
		if (confidence < 0.6) return fallback("low-confidence");
		return {
			id,
			version: 2,
			emotion: choice.choice,
			emotionConfidence: confidence,
			...emotionPerformance[choice.choice],
			source:
				(details.model ?? details.claimed_model) === RURI_MODEL
					? "ruri"
					: (details.model ?? details.claimed_model) &&
						  !(details.model ?? details.claimed_model)!.startsWith("laya")
						? "system-one"
						: "laya",
			model: details.model,
			calibrationStatus: details.calibration_status,
			confidence,
			motionConfidence: confidence,
			toneConfidence: confidence,
			latencyMs: Math.round(performance.now() - started),
		};
	} catch (error) {
		signal.throwIfAborted();
		return fallback(
			abort.signal.aborted
				? "timeout"
				: error instanceof Error &&
					  error.message === "larm_system_one_unavailable"
					? "unavailable"
					: "failed",
		);
	} finally {
		clearTimeout(timer);
		scoped.removeEventListener("abort", stopped);
		abort.abort();
	}
}

export function acceptedAvatarMotion(delivery: SpeechDelivery) {
	if (delivery.version === 2)
		return acceptedEmotion(delivery) ? delivery.motion : null;
	return delivery.source !== "fallback" &&
		(delivery.motionConfidence ?? delivery.confidence) >= 0.6
		? delivery.motion
		: null;
}

export function speechParameters(
	delivery: SpeechDelivery,
	base: {
		speed?: number;
		pitchScale?: number;
		intonationScale?: number;
		autoStrength?: number;
	},
) {
	const strength = base.autoStrength ?? 1;
	const [speed, pitch, intonation] =
		speechDeliverySettings.presets[delivery.tone];
	const clamp = (v: number, min: number, max: number) =>
		Math.max(min, Math.min(max, v));
	return {
		speed: clamp((base.speed ?? 1) + speed * strength, 0.5, 2),
		pitchScale: clamp((base.pitchScale ?? 0) + pitch * strength, -0.15, 0.15),
		intonationScale: clamp(
			(base.intonationScale ?? 1) + intonation * strength,
			0,
			2,
		),
	};
}
