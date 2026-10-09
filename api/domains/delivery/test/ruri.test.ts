import { expect, test } from "bun:test";
import {
	chooseSpeechDelivery,
	decisionDetails,
	emotionSchema,
	RURI_MODEL,
	acceptedEmotion,
	type Emotion,
} from "..";
function response(
	top: Emotion = "warmth",
	choice: Emotion = top,
	confidence = 0.9,
) {
	const score = choice === top ? confidence : 0.9;
	return {
		model: RURI_MODEL,
		answers: {
			emotion: {
				type: "choice",
				choice,
				confidence: 1,
				answer_confidence: confidence,
				logits: Object.fromEntries(
					emotionSchema.options.map((l) => [l, l === top ? 2 : 0]),
				),
				probabilities: Object.fromEntries(
					emotionSchema.options.map((l) => [
						l,
						l === top ? score : (1 - score) / 5,
					]),
				),
				calibration_label_status: "synthetic-provisional",
			},
		},
		truncated: false,
		state_tokens_dropped: 0,
	};
}
const select = (r: unknown) =>
	chooseSpeechDelivery(
		async () => r,
		"こんにちは。",
		new AbortController().signal,
	);
test("Ruri source, calibration, 0.6 adoption and rejected subset preserve original six-class scores", async () => {
	const accepted = await select(response());
	expect(accepted.source).toBe("ruri");
	expect(accepted.calibrationStatus).toBe("synthetic-provisional");
	expect(acceptedEmotion(accepted)).toBe("warmth");
	expect((await select(response("warmth", "warmth", 0.59))).reason).toBe(
		"low-confidence",
	);
	expect((await select(response("warmth", "warmth", 0.6))).source).toBe("ruri");
	const r = response("joy", "none", 0);
	expect((await select(r)).reason).toBe("candidate-restricted");
	expect(decisionDetails(r).scores!.joy).toBe(0.9);
	expect(decisionDetails(r).api_label).toBe("none");
	// Even a provider erroneously renormalizing a subset cannot force adoption.
	expect((await select(response("joy", "warmth", 0.99))).reason).toBe(
		"candidate-restricted",
	);
});
test("top-level and legacy usage truncation are both rejected", async () => {
	for (const flags of [
		{ truncated: true },
		{ state_tokens_dropped: 2 },
		{ usage: { truncated: true } },
		{ usage: { state_tokens_dropped: 1 } },
	])
		expect((await select({ ...response(), ...flags })).reason).toBe("invalid");
});

test("inconsistent Ruri class or confidence cannot drive expressions while its original vectors remain inspectable", async () => {
	const confidenceMismatch = response();
	confidenceMismatch.answers.emotion.answer_confidence = 0.99;
	for (const r of [response("warmth", "none", 0.9), confidenceMismatch]) {
		expect(decisionDetails(r).valid).toBe(false);
		expect(decisionDetails(r).scores?.warmth).toBe(0.9);
		expect((await select(r)).reason).toBe("invalid");
	}
	const r = response();
	r.answers.emotion.probabilities = {
		none: 0.9,
		warmth: 0.02,
		joy: 0.02,
		empathy: 0.02,
		curiosity: 0.02,
		surprise: 0.02,
	};
	expect(decisionDetails(r).valid).toBe(false);
	expect((await select(r)).reason).toBe("invalid");
});
test("missing metadata stays null and unknown raw provider fields are not retained", () => {
	const d = decisionDetails(response());
	expect(d.encoder_revision).toBeNull();
	expect(d.inference_ms).toBeNull();
	expect(d.runtime).toBeNull();
	expect(d.input_mode).toBeNull();
	expect(
		decisionDetails({ ...response(), token: "secret" }),
	).not.toHaveProperty("token");
});

test("recorded truncation agrees with rejection when top-level and legacy flags disagree", async () => {
	const r = {
		...response(),
		usage: { truncated: true, state_tokens_dropped: 3 },
	};
	expect((await select(r)).reason).toBe("invalid");
	expect(decisionDetails(r)).toMatchObject({
		truncated: true,
		state_tokens_dropped: 3,
	});
	expect(
		decisionDetails({
			...response(),
			state_tokens_dropped: 5,
			usage: { state_tokens_dropped: 2 },
		}).state_tokens_dropped,
	).toBe(5);
});

test("malformed Ruri metadata retains its identity and cannot be accepted as Laya", async () => {
	const r = response();
	for (const fields of [
		{ probabilities: { none: 1 } },
		{
			probabilities: Object.fromEntries(
				emotionSchema.options.map((k) => [k, 0.9]),
			),
		},
		{ logits: { none: 1 } },
	]) {
		const malformed = {
			...r,
			answers: { emotion: { ...r.answers.emotion, ...fields } },
		};
		expect(decisionDetails(malformed)).toMatchObject({
			valid: false,
			model: RURI_MODEL,
		});
		expect(await select(malformed)).toMatchObject({
			source: "fallback",
			reason: "invalid",
			model: RURI_MODEL,
		});
	}
});
