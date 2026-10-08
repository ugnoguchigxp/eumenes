/** Phrase-level punctuation and explicit notices; no extra model request. */
export function speechIntonation(text: string, baseline: number): number {
	const multiplier = /[!！]/u.test(text)
		? 1.3
		: /[?？]|(?:ですか|ますか|でしょうか|ませんか)[。\s]*$/u.test(text)
			? 1.2
			: /注意|警告|重要|必ず/u.test(text)
				? 1.15
				: 1;
	return (
		Math.round(Math.max(0, Math.min(2, baseline * multiplier)) * 1000) / 1000
	);
}
