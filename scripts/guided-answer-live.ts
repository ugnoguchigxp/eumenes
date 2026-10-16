import { mkdirSync, writeFileSync } from "node:fs";
import { buildSystemPrompt } from "../api/domains/dialogue/service/system-prompt";
import { researchResultContext } from "../api/domains/dialogue/service/research-result-context";
import { generateConversation } from "../api/domains/dialogue/service/conversation-generation";
import { markCurrentRequest } from "../api/domains/dialogue/service/request-context";
import { createLiveLarm } from "./live-larm";
if (!process.argv.includes("--run")) throw new Error("use --run");
const live = createLiveLarm();
const results = [];
try {
	for (const scenario of [
		{ name: "ordinary", question: "今日の新宿の天気は？", history: false },
		{
			name: "with-long-history",
			question: "今日の新宿の天気は？",
			history: true,
		},
		{
			name: "detailed",
			question: "今日の新宿の天気を詳しく調べて、詳細を教えて",
			history: true,
		},
	]) {
		const question = scenario.question;
		const messages = researchResultContext(
			{
				system: {
					role: "system",
					content: buildSystemPrompt({
						agentName: "",
						userName: "",
						persona: "maid",
					}),
				},
				longTerm: [],
				goals: [],
				history: scenario.history
					? [
							{ role: "user", content: "昨日の天気は？" },
							{
								role: "assistant",
								content:
									"昨日の天気です。\n\n**天気**：晴れ。\n\n**気温**：最高25度、最低18度。\n\n**その他の指標**：\n- 湿度：42〜72%\n- 降水量：0mm\n- 風：北西\n- 紫外線：やや強い\n\n重ね着がおすすめです。",
							},
						]
					: [],
				working: [],
				unprocessed: [],
				input: { role: "user", content: question },
			},
			JSON.stringify({
				delivery: "guided-web",
				answer:
					"新宿は晴れ、夕方から曇り。最高25度、最低18度。湿度42〜72%、降水量0mm、北西の弱い風、紫外線やや強め、傘指数0。重ね着がおすすめです。",
				outcome: "answered",
				summary: "試験用の固定天気資料",
				claims: [
					{
						text: "新宿は晴れ、夕方から曇り。最高25度、最低18度。湿度42〜72%、降水量0mm、北西の弱い風。",
						sourceIds: ["s1"],
					},
				],
				sources: [
					{ id: "s1", url: "https://example.com/weather", title: "試験資料" },
				],
				limitations: [],
			}),
		);
		const generated = await generateConversation({
			inference: live,
			messages: markCurrentRequest(
				messages,
				messages.at(-1)!,
				crypto.randomUUID(),
			),
			signal: AbortSignal.timeout(60000),
			delta: () => {},
			repair: () => {},
			sessionRole: "main",
		});
		const answer = generated.text;
		results.push({ name: scenario.name, question, answer });
	}
} finally {
	await live.close();
	mkdirSync("verification-reports/guided-answer-live", { recursive: true });
	writeFileSync(
		"verification-reports/guided-answer-live/results.json",
		JSON.stringify(results, null, 2),
		{ mode: 0o600 },
	);
}
