import { expect, test } from "bun:test";
import { resultText } from "../service/result-text";
test("a research result keeps the answer, source identity, uncertainty and partial outcome visible", () => {
	const result = resultText(
		{
			ref: "t1",
			title: "調査",
			status: "done",
			outcome: "partial",
			made: [],
			resource: () => null,
			result: {
				status: "partial",
				answer: "結論には留保が必要です。",
				assurance: "model",
				stopReason: "本文が不足",
				claims: [
					{ text: "確定できない事実", status: "unknown", sourceIds: ["e1"] },
				],
				sources: [
					{
						sourceId: "e1",
						url: "https://example.com/source",
						title: "一次資料",
					},
				],
				limitations: ["追加資料が必要"],
			},
		},
		1500,
	);
	expect(result.text).toContain("一部のみ確認できました");
	expect(result.text).toContain("結論には留保");
	expect(result.text).toContain("未確認:");
	expect(result.text).toContain("https://example.com/source");
	expect(result.text).toContain("モデルによる照合");
});
