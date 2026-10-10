import { expect, test } from "bun:test";
import { spokenText } from "../service/spoken-text";

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
		"詳しくはtenki.jpで確認できます。",
	);
	expect(spokenText(`ソース：${link}。今日は晴れです。`)).toBe(
		"ソース：tenki.jp。今日は晴れです。",
	);
	expect(spokenText("出典：資料は見つかりませんでした。")).toBe(
		"出典：資料は見つかりませんでした。",
	);
});
