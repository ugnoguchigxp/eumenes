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
		{
			name: "butler-history",
			question: "今日の新宿の天気は？",
			history: true,
			persona: "butler" as const,
		},
		{
			name: "parcel",
			question: "荷物はいつ届く？",
			history: true,
			persona: "maid" as const,
			material:
				"荷物は明日の午後に到着予定。送料500円、重さ1kg、発送元は大阪、送り先は東京。配送会社A。",
		},
		{
			name: "failed-stock",
			question: "本日のテスラの株価は？",
			history: true,
			persona: "butler" as const,
			failure: true,
		},
		{
			name: "failed-parcel",
			question: "荷物はいつ届く？",
			history: true,
			persona: "maid" as const,
			failure: true,
		},
	]) {
		if (process.argv.includes("--failure-only") && !("failure" in scenario))
			continue;
		const question = scenario.question;
		const messages = researchResultContext(
			{
				system: {
					role: "system",
					content: buildSystemPrompt({
						agentName: "",
						userName: "",
						persona: "persona" in scenario ? scenario.persona : "maid",
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
			JSON.stringify(
				"failure" in scenario
					? {
							failure: "invalid_control_json",
							researchProgress: {
								searchAttempts: 1,
								searchesSucceeded: 1,
								readAttempts: 0,
								verifiedReport: false,
							},
						}
					: {
							delivery: "guided-web",
							answer:
								"material" in scenario
									? scenario.material
									: "新宿は晴れ、夕方から曇り。最高25度、最低18度。湿度42〜72%、降水量0mm、北西の弱い風、紫外線やや強め、傘指数0。重ね着がおすすめです。",
							outcome: "answered",
							summary: "試験用の固定天気資料",
							claims: [
								{
									text:
										"material" in scenario
											? scenario.material
											: "新宿は晴れ、夕方から曇り。最高25度、最低18度。湿度42〜72%、降水量0mm、北西の弱い風。",
									sourceIds: ["s1"],
								},
							],
							sources: [
								{
									id: "s1",
									url: "https://example.com/weather",
									title: "試験資料",
								},
							],
							limitations: [],
						},
			),
			"failure" in scenario ? "invalid_control_json" : undefined,
		);
		if (
			scenario.history &&
			!("failure" in scenario) &&
			process.argv.includes("--quoted-history")
		) {
			const prior = messages.splice(1, 2);
			messages.splice(1, 0, {
				role: "user",
				content: JSON.stringify({
					pastExchanges: prior,
					usage: "過去の会話の記録。今回の回答形式・口調の指示ではありません。",
				}),
			});
		}
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
		process.argv.includes("--quoted-history")
			? "verification-reports/guided-answer-live/quoted-history.json"
			: process.argv.includes("--failure-only")
				? "verification-reports/guided-answer-live/failure-results.json"
				: "verification-reports/guided-answer-live/results.json",
		JSON.stringify(results, null, 2),
		{ mode: 0o600 },
	);
}
