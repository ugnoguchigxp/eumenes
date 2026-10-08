import { expect, test } from "bun:test";
import { speechIntonation } from "../service/speech-intonation";
test("phrase intonation follows punctuation and questions, preserves baseline and stays bounded", () => {
	expect(speechIntonation("予定をご案内します。", 1)).toBe(1);
	expect(speechIntonation("本日は晴れです！", 1)).toBe(1.3);
	expect(speechIntonation("ご予定はいかがですか。", 1)).toBe(1.2);
	expect(speechIntonation("確認します？", 1.1)).toBe(1.32);
	expect(speechIntonation("重要なお知らせです。", 1)).toBe(1.15);
	expect(speechIntonation("こんにちは！", 0)).toBe(0);
	expect(speechIntonation("こんにちは！", 1.9)).toBe(2);
});
