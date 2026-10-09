import { expect, test } from "bun:test";
import {
	acceptedEmotion,
	chooseSpeechDelivery,
	deliveryState,
	emotionCandidates,
	speechParameters,
	speechQuestions,
	type Emotion,
} from "..";
const decision = (
	emotion: string = "warmth",
	probability = 0.9,
	applicability = 0.9,
) => ({
	answers: {
		emotion: {
			type: "choice",
			choice: emotion,
			confidence: applicability,
			answer_confidence: probability,
		},
	},
});
test("full reply and recent conversation decide emotion; speech motion and voice are separate derived actions", async () => {
	const context = {
		answer: "なるほど。それは素敵な由来ですね。",
		turns: [{ role: "user" as const, text: "24歳まで生きた猫の名前です。" }],
	};
	const delivery = await chooseSpeechDelivery(
		async (state, questions) => {
			expect(state.response).toBe(context.answer);
			expect(JSON.parse(state.conversation!)).toEqual(context.turns);
			expect(questions.emotion?.criteria).toEqual({
				none: speechQuestions.emotion!.criteria.none!,
				warmth: speechQuestions.emotion!.criteria.warmth!,
			});
			expect(Object.keys(questions)).toEqual(["emotion"]);
			return decision("warmth");
		},
		"なるほど。",
		new AbortController().signal,
		2000,
		context,
	);
	expect(delivery).toMatchObject({
		version: 2,
		emotion: "warmth",
		motion: "agreeing",
		tone: "bright",
		source: "laya",
	});
	expect(acceptedEmotion(delivery)).toBe("warmth");
	expect(
		speechParameters(delivery, {
			speed: 1.99,
			pitchScale: 0.14,
			intonationScale: 1.95,
		}),
	).toEqual({ speed: 2, pitchScale: 0.15, intonationScale: 2 });
});
test("unnecessary, uncertain, invalid or truncated choices never become emotion icons", async () => {
	for (const [value, source, reason] of [
		[decision("none"), "laya", undefined],
		[decision("warmth", 0.59), "fallback", "low-confidence"],
		[decision("sleepy"), "fallback", "invalid"],
		[decision("joy", 0.99), "fallback", "invalid"],
		[decision("joy", Number.NaN), "fallback", "invalid"],
		[
			{ ...decision(), usage: { state_tokens_dropped: 1 } },
			"fallback",
			"invalid",
		],
	] as const) {
		const delivery = await chooseSpeechDelivery(
			async () => value,
			"こんにちは。",
			new AbortController().signal,
		);
		expect(delivery.source).toBe(source);
		expect(delivery.reason).toBe(reason);
		expect(delivery.motion).toBe("neutral");
		expect(acceptedEmotion(delivery)).toBeNull();
	}
});
test("evidence comes from this response and latest user; quotes, code and negation do not force emotion", async () => {
	for (const answer of [
		"一時間は3600秒です。",
		"「ありがとう。素敵ですね！」は二文です。",
		"値は `素敵ですね、ありがとう` です。",
		"```\nおめでとうございます！\n```\nこれはコードの例です。",
		"> 合格おめでとうございます！\n引用です。",
		"うれしくない、という文です。",
		"親しみとは、人や物に近しさを感じることです。",
	]) {
		let calls = 0;
		const delivery = await chooseSpeechDelivery(
			async () => {
				calls++;
				return decision("joy");
			},
			answer,
			new AbortController().signal,
		);
		expect(calls).toBe(0);
		expect(delivery.reason).toBe("not-expressive");
	}
	expect(
		emotionCandidates("無理せず休んでください。", {
			answer: "無理せず休んでください。",
			turns: [
				{ role: "user", text: "悲しいです。" },
				{ role: "assistant", text: "つらいですね。" },
				{ role: "user", text: "PCのスリープ設定は？" },
			],
		}),
	).toEqual([]);
	expect(
		emotionCandidates("無理に喜ばなくても大丈夫です。", {
			answer: "無理に喜ばなくても大丈夫です。",
			turns: [{ role: "user", text: "合格したのに喜べない。" }],
		}),
	).toEqual(["empathy"]);
	expect(
		emotionCandidates("親しみとは近しさを感じることです。素敵なお名前ですね。"),
	).toEqual(["warmth"]);
});
test("selected-answer probability is required and is not question applicability", async () => {
	const result = await chooseSpeechDelivery(
		async () => decision("joy", 0.9, 0.2),
		"合格おめでとうございます。",
		new AbortController().signal,
	);
	expect(result).toMatchObject({
		source: "laya",
		emotion: "joy",
		emotionConfidence: 0.9,
	});
	const missing = {
		answers: { emotion: { type: "choice", choice: "joy", confidence: 0.9 } },
	};
	expect(
		(
			await chooseSpeechDelivery(
				async () => missing,
				"合格おめでとうございます。",
				new AbortController().signal,
			)
		).reason,
	).toBe("invalid");
});
test("timeout is bounded and caller cancellation or a late answer cannot restore emotion", async () => {
	let finish!: (value: unknown) => void;
	const late = new Promise((resolve) => {
		finish = resolve;
	});
	const result = await chooseSpeechDelivery(
		async () => late,
		"こんにちは。",
		new AbortController().signal,
		5,
	);
	expect(result.reason).toBe("timeout");
	finish(decision());
	await Bun.sleep(1);
	expect(acceptedEmotion(result)).toBeNull();
	const abort = new AbortController();
	const work = chooseSpeechDelivery(
		async () => new Promise(() => {}),
		"こんにちは。",
		abort.signal,
	);
	abort.abort();
	await expect(work).rejects.toThrow();
	expect(
		(
			await chooseSpeechDelivery(
				undefined,
				"こんにちは。",
				new AbortController().signal,
			)
		).reason,
	).toBe("unavailable");
});
test("all expressions map to restrained motion without classifying drowsiness or actions as emotions", async () => {
	for (const emotion of [
		"warmth",
		"joy",
		"empathy",
		"curiosity",
		"surprise",
	] as Exclude<Emotion, "none">[]) {
		const result = await chooseSpeechDelivery(
			async () => decision(emotion),
			{
				warmth: "素敵ですね。",
				joy: "おめでとうございます。",
				empathy: "つらかったですね。無理せず休んでください。",
				curiosity: "面白そうですね。聞かせてください。",
				surprise: "びっくりしました。",
			}[emotion as Exclude<Emotion, "none">],
			new AbortController().signal,
			2000,
			{
				answer:
					"つらかったですね。素敵ですね。おめでとうございます。面白そうです。聞かせてください。びっくりしました。",
				turns: [{ role: "user", text: "つらいですが合格しました。" }],
			},
		);
		expect(acceptedEmotion(result)).toBe(emotion);
		expect(result.motion).not.toBe("sleepy");
	}
});
test("long data stays bounded, preserves beginnings and endings, excludes system instructions and older turns", () => {
	const state = deliveryState("句", {
		answer: "開始" + "あ".repeat(10000) + "終端",
		turns: Array.from({ length: 8 }, (_, i) => ({
			role: "user" as const,
			text: `${i}:` + "い".repeat(2000) + "末尾",
		})),
	});
	expect(state.response?.startsWith("開始")).toBe(true);
	expect(state.response?.endsWith("終端")).toBe(true);
	expect(JSON.parse(state.conversation!)).toHaveLength(4);
	expect(new TextEncoder().encode(JSON.stringify(state)).length).toBeLessThan(
		4000,
	);
});
