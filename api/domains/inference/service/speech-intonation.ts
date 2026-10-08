/** Phrase-level punctuation and explicit notices; no extra model request. */
export function speechIntonation(
	text: string,
	baseline: number,
	strength = 1,
): number {
	const multiplier = /[!！]/u.test(text)
		? 1.3
		: /[?？]|(?:ですか|ますか|でしょうか|ませんか)[。\s]*$/u.test(text)
			? 1.2
			: /注意|警告|重要|必ず/u.test(text)
				? 1.15
				: 1;
	const scaled = 1 + (multiplier - 1) * strength;
	return Math.round(Math.max(0, Math.min(2, baseline * scaled)) * 1000) / 1000;
}

const clamp = (v: number, min: number, max: number) =>
	Math.max(min, Math.min(max, v));
const round = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Phrase-level speed, pitch and intonation moved from the saved baseline by
 * punctuation and notices. `strength` scales every deviation (0 keeps the baseline).
 */
export function speechAdjustment(
	text: string,
	base: { speed?: number; pitchScale?: number; intonationScale?: number },
	strength = 1,
) {
	const kind = /[!！]/u.test(text)
		? "exclaim"
		: /[?？]|(?:ですか|ますか|でしょうか|ませんか)[。\s]*$/u.test(text)
			? "question"
			: /注意|警告|重要|必ず/u.test(text)
				? "notice"
				: "plain";
	const [speed = 0, pitch = 0] = {
		exclaim: [0.05, 0.02],
		question: [0, 0.015],
		notice: [-0.05, -0.01],
		plain: [0, 0],
	}[kind];
	return {
		speed: round(clamp((base.speed ?? 1) + speed * strength, 0.5, 2)),
		pitchScale: round(
			clamp((base.pitchScale ?? 0) + pitch * strength, -0.15, 0.15),
		),
		intonationScale: speechIntonation(
			text,
			base.intonationScale ?? 1,
			strength,
		),
	};
}
