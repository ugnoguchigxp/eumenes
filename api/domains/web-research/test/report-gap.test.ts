import { expect, test } from "bun:test";
import { shortForecastReportGap } from "../service/report-gap";
test("a forecast request cannot be answered by the existence of a forecast page", () => {
	const unavailable = {
		claims: [
			{
				text: "鎌倉の天気予報は公開されています。",
				evidence: [{ quote: "今日明日の天気予報" }],
			},
		],
	};
	expect(shortForecastReportGap("今日の鎌倉の天気教えて。", unavailable)).toBe(
		"weather_condition_missing",
	);
	const weather = {
		claims: [{ text: "晴れです。", evidence: [{ quote: "晴れ 26 17" }] }],
	};
	expect(
		shortForecastReportGap("今日の鎌倉の天気教えて。", weather),
	).toBeNull();
	expect(shortForecastReportGap("明日の天気と最高気温", weather)).toBe(
		"weather_high_missing",
	);
	expect(shortForecastReportGap("Bunのテストコマンド", unavailable)).toBeNull();
});
