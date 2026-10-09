import { decisionDetails, RURI_MODEL } from "./result";
import { z } from "zod";
import { emotionCandidates, expressionText } from "./evidence";
export { emotionCandidates } from "./evidence";
export { acceptedEmotion };
export type { Judge };
import {
	acceptedEmotion,
	type Judge,
	emotionSchema,
	type Emotion,
	type DeliveryContext,
	type ChoiceQuestions,
	type SpeechDelivery,
} from "../contracts";

export const speechQuestions: ChoiceQuestions = {
	emotion: {
		type: "choice",
		instructions:
			"現在の回答をアシスタント自身が話す表情と声色を選んでください。文章中の感情やユーザーの感情ではなく、話す態度を分類してください。",
		criteria: {
			none: "通常。事実・操作手順の説明",
			warmth: "親しみ。素敵・ありがとう・挨拶・温かい言葉",
			joy: "喜び。達成・成功・良い知らせを喜ぶ",
			empathy: "共感。つらいですね・大丈夫・無理しないで・一緒に整理",
			curiosity: "興味。相手の話の続きを知りたい",
			surprise: "驚き。予想外の出来事への驚き",
		},
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

export const emotionPerformance: Record<
	Emotion,
	{ motion: SpeechDelivery["motion"]; tone: SpeechDelivery["tone"] }
> = {
	none: { motion: "neutral", tone: "natural" },
	warmth: { motion: "agreeing", tone: "bright" },
	joy: { motion: "joyful", tone: "bright" },
	empathy: { motion: "listening", tone: "gentle" },
	curiosity: { motion: "curious", tone: "natural" },
	surprise: { motion: "surprised", tone: "bright" },
};

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
		text: excerpt(expressionText(turn.text), 120),
	}));
	if (turns?.length) state.conversation = JSON.stringify(turns);
	state.current_chunk = excerpt(context?.answer || text, 600);
	state.response = excerpt(expressionText(context?.answer || text), 600);
	return state;
}
export async function chooseSpeechDelivery(
	judge: Judge | undefined,
	text: string,
	signal: AbortSignal,
	budgetMs = 2000,
	context?: DeliveryContext,
	options: { fullCandidates?: boolean } = {},
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
	const candidates = options.fullCandidates
		? emotionSchema.options.filter((label) => label !== "none")
		: emotionCandidates(text, context);
	if (!candidates.length) return fallback("not-expressive");
	const questions: ChoiceQuestions = {
		emotion: {
			...speechQuestions.emotion!,
			criteria: {
				none: speechQuestions.emotion!.criteria.none!,
				...Object.fromEntries(
					candidates.map((emotion) => [
						emotion,
						speechQuestions.emotion!.criteria[emotion]!,
					]),
				),
			},
		},
	};

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
		if (choice.choice !== "none" && !candidates.includes(choice.choice))
			return fallback("invalid");
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
				...fallback("candidate-restricted"),
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
	const preset = {
		natural: [0, 0, 0],
		bright: [0.05, 0.02, 0.15],
		gentle: [-0.06, -0.01, -0.1],
		serious: [-0.04, 0, 0.05],
		excited: [0.08, 0.025, 0.2],
	} as const;
	const [speed, pitch, intonation] = preset[delivery.tone];
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
