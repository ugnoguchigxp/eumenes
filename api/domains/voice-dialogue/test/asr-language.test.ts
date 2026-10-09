import { expect, test } from "bun:test";
import { transcriptAllowed } from "../service/asr-language";

test("日本語と英語のみ許可すると中国語の聞き取りを破棄する", () => {
	const allowed = ["ja", "en"] as const;
	expect(transcriptAllowed("嗯。", allowed)).toBe(false);
	expect(transcriptAllowed("你好", allowed)).toBe(false);
	expect(transcriptAllowed("안녕하세요", allowed)).toBe(false);
	expect(transcriptAllowed("おっ", allowed)).toBe(true);
	expect(transcriptAllowed("了解", allowed)).toBe(true);
	expect(transcriptAllowed("Hello、今日は", allowed)).toBe(true);
	expect(transcriptAllowed("3分タイマー測って", allowed)).toBe(true);
	expect(transcriptAllowed("ニュースを調べて", allowed)).toBe(true);
	expect(transcriptAllowed("。", allowed)).toBe(true);
});

test("中国語を許可すると漢字のみの文を通す", () => {
	expect(transcriptAllowed("嗯。", ["ja", "zh"])).toBe(true);
});
