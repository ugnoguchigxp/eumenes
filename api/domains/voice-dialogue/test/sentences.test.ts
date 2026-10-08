import { expect, test } from "bun:test";
import { SpeechSentences } from "../service/sentences";
test("punctuation clauses and decimal numbers survive every token split without repeated tails", () => {
	const source = "承知しました。値は3.14です、次を確認します。末尾";
	for (let split = 0; split <= source.length; split++) {
		const sentences = new SpeechSentences();
		const chunks = [
			...sentences.append(source.slice(0, split)),
			...sentences.append(source),
			...sentences.append(source, true),
		];
		expect(chunks).toEqual([
			"承知しました。",
			"値は3.14です、",
			"次を確認します。",
			"末尾",
		]);
		expect(sentences.append(source, true)).toEqual([]);
	}
});
test("long unpunctuated output is bounded and conflicting final text is rejected", () => {
	const sentences = new SpeechSentences();
	expect(sentences.append("あ".repeat(600))).toEqual([
		"あ".repeat(240),
		"あ".repeat(240),
	]);
	expect(() => sentences.append("別の回答", true)).toThrow(
		"speech_stream_diverged",
	);
});
