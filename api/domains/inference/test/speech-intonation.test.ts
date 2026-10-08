import { expect, test } from "bun:test";
import {
	speechAdjustment,
	speechIntonation,
} from "../service/speech-intonation";
test("phrase intonation follows punctuation and questions, preserves baseline and stays bounded", () => {
	expect(speechIntonation("予定をご案内します。", 1)).toBe(1);
	expect(speechIntonation("本日は晴れです！", 1)).toBe(1.3);
	expect(speechIntonation("ご予定はいかがですか。", 1)).toBe(1.2);
	expect(speechIntonation("確認します？", 1.1)).toBe(1.32);
	expect(speechIntonation("重要なお知らせです。", 1)).toBe(1.15);
	expect(speechIntonation("こんにちは！", 0)).toBe(0);
	expect(speechIntonation("こんにちは！", 1.9)).toBe(2);
});
test("auto strength scales the deviation from the baseline", () => {
	expect(speechIntonation("本日は晴れです！", 1, 0)).toBe(1);
	expect(speechIntonation("本日は晴れです！", 1, 0.5)).toBe(1.15);
	expect(speechIntonation("本日は晴れです！", 1, 2)).toBe(1.6);
	expect(speechIntonation("本日は晴れです。", 1, 2)).toBe(1);
});
test("phrase adjustment moves speed and pitch from the baseline and respects strength", () => {
	const base = { speed: 1, pitchScale: 0, intonationScale: 1 };
	expect(speechAdjustment("予定です。", base)).toEqual(base);
	expect(speechAdjustment("本日は晴れです！", base)).toEqual({
		speed: 1.05,
		pitchScale: 0.02,
		intonationScale: 1.3,
	});
	expect(speechAdjustment("重要なお知らせです。", base)).toEqual({
		speed: 0.95,
		pitchScale: -0.01,
		intonationScale: 1.15,
	});
	expect(speechAdjustment("本日は晴れです！", base, 0)).toEqual(base);
	expect(
		speechAdjustment("本日は晴れです！", { ...base, pitchScale: 0.14 }, 2)
			.pitchScale,
	).toBe(0.15);
});
