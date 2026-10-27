import { mkdirSync, writeFileSync } from "node:fs";
import { respondSystemParts } from "eumenes-agency";
import { systemText } from "../api/domains/dialogue/service/context-system";
import { createLiveLarm } from "./live-larm";
import type { Messages } from "../api/domains/inference/contracts";

if (!process.argv.includes("--run")) throw new Error("use --run");
const live = createLiveLarm();
const results: { name: string; answer: string; expected: string }[] = [];
const cases = [
	{
		name: "simple",
		input: "1時間は何分？",
		expected: "60分を短く答える。換算方法や提案を加えない。",
	},
	{
		name: "explanation",
		input: "虹はどうしてできるの？",
		expected: "光と水滴の関係を1〜2文で答える。関連知識を列挙しない。",
	},
	{
		name: "details",
		input:
			"虹ができる仕組みを、屈折と反射と色の分かれ方に分けて詳しく説明して。",
		expected: "指定された3点を説明する。短さだけを優先して説明を省かない。",
	},
	{
		name: "after-details",
		input: "1日は何時間？",
		expected: "24時間を短く答える。前の詳細指定を引き継がない。",
	},
	{
		name: "report",
		input: "明日の降水確率だけ教えて。",
		expected: "60%だけを答える。服装、持ち物、予定の提案を加えない。",
		report:
			"調査結果（試験用資料）: 明日の降水確率は60%。気温18度、風速3m。傘を持ち、上着を用意し、屋内の予定も考えるとよい。",
	},
];
try {
	const history: Messages = [];
	for (const scenario of cases) {
		const messages: Messages = [
			{
				role: "system",
				content: systemText(
					{
						agentName: "",
						userName: "",
						persona: "butler",
					},
					respondSystemParts({ spoken: true }),
				),
			},
			...history,
			...(scenario.report
				? [{ role: "user" as const, content: scenario.report }]
				: []),
			{ role: "user", content: scenario.input },
		];
		const answer = await live.answer(messages, AbortSignal.timeout(60000), {
			contextPolicy: "exact",
		});
		results.push({ name: scenario.name, answer, expected: scenario.expected });
		if (scenario.name === "details")
			history.push(
				{ role: "user", content: scenario.input },
				{ role: "assistant", content: answer },
			);
		console.log(JSON.stringify(results.at(-1)));
	}
} finally {
	await live.close();
	mkdirSync("verification-reports/short-answer-live", { recursive: true });
	writeFileSync(
		"verification-reports/short-answer-live/results.json",
		JSON.stringify(results, null, 2),
		{ mode: 0o600 },
	);
}
