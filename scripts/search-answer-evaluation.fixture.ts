import type { SearchAnswerSample } from "./search-answer-evaluation";

// Public-page excerpts captured on 2026-10-16. These are test data, never live quotes.
const stockUrl = "https://finance.yahoo.co.jp/quote/9434.T";
const stockText =
	"ソフトバンク(株)【9434.T】\n243.8\n前日比\n+1.1(+0.45%)\n- リアルタイム株価\n- 13:11\n夜間PTS---\nただいま取引時間外です\n- 前日終値\n242.7(10/15)\n- 始値\n243.9(09:00)\n## 夜間PTSについて\n- 取引値 / 東証終値比\n242.70(0.00%)(23:47)";
const weatherUrl = "https://tenki.jp/forecast/3/17/4610/14204/1hour.html";
const weatherText =
	"鎌倉市の天気16日13:00発表\n日付: 今日 2026年10月16日(金)\n|時刻|天気|気温 (℃)|\n|昼過ぎ / 13|晴れ|25.4|\n日付: 明日 2026年10月17日(土)\n|昼過ぎ / 13|晴れ|24.5|";
const report = (url: string, quote: string, text: string) => ({
	summary: text,
	claims: [{ text, evidence: [{ sourceId: "s1", quote }] }],
	sources: [{ sourceId: "s1", url }],
});
export const stockSample: SearchAnswerSample = {
	reviewed: {
		statements: [
			["9434"],
			["リアルタイム", "現在値", "現在の株価"],
			["243.8"],
			["円"],
			["13:11", "13時11分"],
			["日付は未確認", "日付は資料では確認できません", "日付は確認できません"],
		],
		quoted: [["9434"], ["243.8"], ["13:11"]],
	},
	request:
		"ソフトバンク（9434）の現在の株価を教えて。価格とその日時、出典を示してください。",
	now: "2026-10-16T13:25:00+09:00",
	expected: [
		"対象はソフトバンク株式会社9434。グループ9984ではない。",
		"リアルタイム株価243.8円、表示時刻13:11。終値ではない。",
		"価格の日付はこの資料では未確認。取得日を価格の日付として断定しない。",
		"前日終値242.7円と始値243.9円は別項目。夜間PTS242.70円23:47の日付も不明。",
	],
	documents: [{ url: stockUrl, text: stockText }],
	report: report(
		stockUrl,
		stockText,
		"ソフトバンク（9434）のリアルタイム株価は243.8円、13:11表示。価格の日付は未確認です。",
	),
	answer: `ソフトバンク（9434）のリアルタイム株価は243.8円、13:11表示です。価格の日付は資料では確認できません。[出典](${stockUrl})`,
};
export const weatherSample: SearchAnswerSample = {
	reviewed: {
		statements: [
			["鎌倉"],
			["予報"],
			["25.4"],
			["℃", "度", "°C"],
			["2026年10月16日", "2026-10-16", "10月16日"],
			["13時", "13:00"],
		],
		quoted: [["鎌倉"], ["2026年10月16日", "2026-10-16"], ["25.4"], ["13"]],
	},
	request: "今度は鎌倉の今日の天気を教えて。予報と気温、出典を示してください。",
	now: stockSample.now,
	expected: [
		"対象は神奈川県鎌倉市、2026年10月16日の予報。",
		"13時の予報は晴れ、25.4℃。観測値や一日の最高・最低ではない。",
		"24.5℃は翌日17日13時の値。横浜の情報は代用しない。",
	],
	documents: [{ url: weatherUrl, text: weatherText }],
	report: report(
		weatherUrl,
		weatherText,
		"2026年10月16日の鎌倉市は13時の予報で晴れ、25.4℃。",
	),
	answer: `2026年10月16日の鎌倉市は13時の予報で晴れ、25.4℃です。[出典](${weatherUrl})`,
};
const definitionText = "仙台市は宮城県の県庁所在地です。";
export const definitionSample: SearchAnswerSample = {
	reviewed: {
		statements: [["仙台市"], ["宮城県"]],
		quoted: [["仙台市"], ["宮城県"]],
	},
	request: "仙台市は何県にあるか調べて教えて",
	now: stockSample.now,
	expected: ["仙台市は宮城県にある。日時や数値を求める依頼ではない。"],
	documents: [{ url: "https://example.org/sendai", text: definitionText }],
	report: report("https://example.org/sendai", definitionText, definitionText),
	answer: definitionText + " [出典](https://example.org/sendai)",
};
// Synthetic positive control with an explicit quote date, unlike the captured page.
const completeStockText =
	"ソフトバンク（9434）のリアルタイム株価：2026年10月16日13:11 JST、243.8円。前日終値242.7円。";
const completeStock: SearchAnswerSample = {
	...stockSample,
	reviewed: {
		statements: [
			["9434"],
			["リアルタイム", "現在値"],
			["243.8"],
			["円"],
			["2026年10月16日", "2026-10-16"],
			["13:11", "13時11分"],
		],
		quoted: [["9434"], ["243.8"], ["2026年10月16日"], ["13:11"]],
	},
	expected: [
		"ソフトバンク9434、リアルタイム株価243.8円、2026年10月16日13:11 JST。前日終値は別項目。",
	],
	documents: [
		{ url: "https://example.org/quote/9434", text: completeStockText },
	],
	report: report(
		"https://example.org/quote/9434",
		completeStockText,
		"ソフトバンク（9434）のリアルタイム株価は2026年10月16日13:11 JST時点で243.8円です。",
	),
	answer:
		"ソフトバンク（9434）のリアルタイム株価は2026年10月16日13:11 JST時点で243.8円です。[出典](https://example.org/quote/9434)",
};
function changed(sample: SearchAnswerSample, text: string): SearchAnswerSample {
	return {
		...sample,
		report: {
			...sample.report!,
			summary: text,
			claims: [{ ...sample.report!.claims[0]!, text }],
		},
		answer: text + ` [出典](${sample.documents[0]!.url})`,
	};
}
export const searchAnswerControls: Array<{
	id: string;
	expected: boolean;
	sample: SearchAnswerSample;
}> = [
	{ id: "correct-weather", expected: true, sample: weatherSample },
	{
		id: "correct-stock-with-explicit-date",
		expected: true,
		sample: completeStock,
	},
	{ id: "timeless-definition", expected: true, sample: definitionSample },
	// A complete response can honestly explain an unknown fact.
	{ id: "honest-missing-stock-date", expected: true, sample: stockSample },
	{
		id: "realtime-as-close-and-undated-pts",
		expected: false,
		sample: changed(
			stockSample,
			"ソフトバンク（9434）の2026年10月16日の終値付近は243.8円、13:11です。同日の夜間PTSは23:47時点で242.70円です。",
		),
	},
	{
		id: "previous-close-as-opening",
		expected: false,
		sample: changed(
			stockSample,
			"ソフトバンク（9434）の始値は242.7円、09:00です。",
		),
	},
	{
		id: "wrong-company",
		expected: false,
		sample: changed(
			stockSample,
			"ソフトバンクグループ（9984）の現在値は243.8円、13:11です。",
		),
	},
	{
		id: "wrong-region",
		expected: false,
		sample: changed(
			weatherSample,
			"2026年10月16日の横浜市は13時の予報で晴れ、25.4℃です。",
		),
	},
	{
		id: "tomorrow-as-today",
		expected: false,
		sample: changed(
			weatherSample,
			"2026年10月16日の鎌倉市は13時の予報で晴れ、24.5℃です。",
		),
	},
	{
		id: "hourly-as-maximum",
		expected: false,
		sample: changed(
			weatherSample,
			"2026年10月16日の鎌倉市は晴れ、最高気温25.4℃です。",
		),
	},
	{
		id: "rounded-temperature",
		expected: false,
		sample: changed(
			weatherSample,
			"2026年10月16日の鎌倉市は13時の予報で晴れ、25℃です。",
		),
	},
	{
		id: "date-not-in-cited-evidence",
		expected: false,
		sample: {
			...weatherSample,
			report: {
				...weatherSample.report!,
				claims: [
					{
						...weatherSample.report!.claims[0]!,
						evidence: [{ sourceId: "s1", quote: "|昼過ぎ / 13|晴れ|25.4|" }],
					},
				],
			},
		},
	},
	{
		id: "link-only-in-code",
		expected: false,
		sample: {
			...weatherSample,
			answer: weatherSample.answer!.replace("[出典]", "`[出典]") + "`",
		},
	},
];
