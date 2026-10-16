import { expect, test } from "bun:test";
import { spokenPrefix, spokenText } from "../service/spoken-text";
import { SpeechSentences } from "../service/sentences";

test("displayed citations stay out of speech while inline labels and surrounding facts survive", () => {
	const body = "調べました。晴れ、最高26度、最低17度、降水確率0％です。";
	const link = "[tenki.jp](https://tenki.jp/forecast/3/17/4610/14204/)";
	const displayed = `${body}\n\nソース：${link}`;
	expect(spokenText(displayed)).toBe(body);
	expect(displayed).toContain("https://tenki.jp/forecast/3/17/4610/14204/");
	expect(spokenText(`出典：${link}\n雨はありません。`)).toBe(
		"雨はありません。",
	);
	expect(spokenText(`詳しくは${link}で確認できます。`)).toBe(
		"詳しくはで確認できます。",
	);
	expect(spokenText(`ソース：${link}。今日は晴れです。`)).toBe(
		"今日は晴れです。",
	);
	expect(spokenText("出典：資料は見つかりませんでした。")).toBe(
		"出典：資料は見つかりませんでした。",
	);
});

test("links and citations arriving across any token boundary never change or duplicate emitted speech", () => {
	for (const body of [
		"見てください。[公式の例。](https://example.com/test)もあります。\n出典：[資料](https://example.com/)\n最後です。",
		"最初の行\nソース：[資料](https://example.com/)\n最後です。",
		"普通の[角括弧]も読みます。",
		"本文です。https://example.com/a.b?q=1 は画面で確認してください。\n出典：https://example.com/report\n続きです。",
		"参照先はtenki.jp/pathです。\n参考資料：[example.com](<https://example.com/>)",
	]) {
		const expected = new SpeechSentences().append(spokenText(body), true);
		for (let split = 0; split <= body.length; split++) {
			const sentences = new SpeechSentences(true);
			const result = sentences.append(spokenPrefix(body.slice(0, split)));
			result.push(...sentences.append(spokenPrefix(body, true), true));
			expect(result).toEqual(expected);
		}
		const sentences = new SpeechSentences(true),
			result: string[] = [];
		for (let i = 1; i <= body.length; i++)
			result.push(...sentences.append(spokenPrefix(body.slice(0, i))));
		result.push(...sentences.append(spokenPrefix(body, true), true));
		expect(result).toEqual(expected);
	}
});
